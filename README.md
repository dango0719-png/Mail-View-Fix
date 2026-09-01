# Mail Viewer - Customer mail:pass:server:port login

Customer enters:
- Email
- Password
- Mail server (e.g. imap.example.com / pop.example.com)
- Protocol: IMAP or POP3
- Port (e.g. IMAP 993, POP3 995)
- SSL/TLS on/off

The server verifies the credentials against the selected mail server, then
keeps them only in RAM for a short session. They are not written to a file
or database. Railway only needs the normal Node app; no fixed IMAP_USER/PASS.

Important:
- For IMAP SSL use port 993.
- For POP3 SSL use port 995.
- Port 143/110 can be used for non-direct SSL where the server supports STARTTLS.
