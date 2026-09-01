const express = require('express');
const { ImapFlow } = require('imapflow');
const Pop3Command = require('node-pop3');
const { simpleParser } = require('mailparser');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/read-mail', async (req, res) => {
    const { host, port, email, password, searchKeyword } = req.body;
    const portNum = parseInt(port);

    if (!host || !portNum || !email || !password) {
        return res.status(400).json({ success: false, message: "Vui lòng điền đầy đủ các thông tin đăng nhập!" });
    }

    let emails = [];

    try {
        // ==========================================
        // RẼ NHÁNH 1: XỬ LÝ GIAO THỨC POP3 (Port 110 hoặc 995)
        // ==========================================
        if (portNum === 110 || portNum === 995) {
            if (searchKeyword && searchKeyword.trim() !== "") {
                return res.status(400).json({ 
                    success: false, 
                    message: "Giao thức POP3 không hỗ trợ tính năng tìm kiếm trên máy chủ. Vui lòng để trống ô tìm kiếm hoặc dùng IMAP." 
                });
            }

            const pop3 = new Pop3Command({
                user: email.trim(),
                password: password,
                host: host.trim(),
                port: portNum,
                tls: portNum === 995,
                tlsOptions: { rejectUnauthorized: false } // Bỏ qua lỗi chứng chỉ bảo mật SSL
            });

            // Không gọi pop3.login() vì thư viện tự động đăng nhập ngầm khi khởi tạo

            // Lấy thông tin hộp thư (STAT trả về tổng số thư)
            const stat = await pop3.STAT();
            const totalMessages = parseInt(stat.count);

            if (totalMessages === 0) {
                await pop3.QUIT();
                return res.json({ success: true, data: [] });
            }

            // Lấy tối đa 5 thư mới nhất (POP3 đánh số từ 1 đến N, N là thư mới nhất)
            const startMsg = Math.max(1, totalMessages - 4);

            for (let i = totalMessages; i >= startMsg; i--) {
                // Tải nội dung thư thô bằng lệnh RETR
                const msgSource = await pop3.RETR(i);
                
                // Dịch nội dung thư bằng mailparser
                const parsed = await simpleParser(msgSource);
                
                emails.push({
                    subject: parsed.subject || "(Không có chủ đề)",
                    from: parsed.from ? parsed.from.text : "Unknown Sender",
                    date: parsed.date,
                    body: parsed.html || parsed.textAsHtml || parsed.text || "Không có nội dung"
                });
            }

            await pop3.QUIT();
            return res.json({ success: true, data: emails });
        } 
        
        // ==========================================
        // RẼ NHÁNH 2: XỬ LÝ GIAO THỨC IMAP (Các Port còn lại như 993, 143)
        // ==========================================
        else {
            const client = new ImapFlow({
                host: host.trim(),
                port: portNum,
                secure: portNum === 993,
                auth: { user: email.trim(), pass: password },
                tls: { rejectUnauthorized: false }, // Bỏ qua lỗi chứng chỉ bảo mật SSL
                logger: false 
            });

            await client.connect();
            let lock = await client.getMailboxLock('INBOX');
            
            let fetchSequence;

            // Kiểm tra điều kiện tìm kiếm mail
            if (searchKeyword && searchKeyword.trim() !== "") {
                const searchResults = await client.search({ text: searchKeyword.trim() });
                if (!searchResults || searchResults.length === 0) {
                    lock.release();
                    await client.logout();
                    return res.json({ success: true, data: [] });
                }
                // Lấy tối đa 10 kết quả tìm kiếm mới nhất
                fetchSequence = searchResults.slice(-10);
            } else {
                const totalMessages = client.mailbox.exists; 
                if (totalMessages === 0) {
                    lock.release();
                    await client.logout();
                    return res.json({ success: true, data: [] });
                }
                // Nếu không tìm kiếm, mặc định lấy 5 thư mới nhất
                const startMsg = Math.max(1, totalMessages - 4); 
                fetchSequence = `${startMsg}:*`;
            }

            for await (let msg of client.fetch(fetchSequence, { source: true })) {
                const parsed = await simpleParser(msg.source);
                emails.push({
                    subject: parsed.subject || "(Không có chủ đề)",
                    from: parsed.from ? parsed.from.text : "Unknown Sender",
                    date: parsed.date,
                    body: parsed.html || parsed.textAsHtml || parsed.text || "Không có nội dung" 
                });
            }

            lock.release();
            await client.logout();

            return res.json({ success: true, data: emails.reverse() });
        }

    } catch (error) {
        console.error("Lỗi hệ thống Mail:", error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// Chạy ứng dụng trên cổng động và cho phép mọi nguồn kết nối (0.0.0.0)
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Ứng dụng Webmail đang chạy thành công tại cổng: ${PORT}`);
});