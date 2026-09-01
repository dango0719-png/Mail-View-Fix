# Mail Viewer - Railway Customer Login

The customer logs in from the browser with their email address and password.
No IMAP username/password is required in Railway Variables.

Required Railway variables:
- IMAP_HOST=m4.kcn.ne.jp
- IMAP_PORT=143
- IMAP_SECURE=false

The customer credentials are kept only in server memory for a short-lived session
and are not written to disk/database. Restarting the Railway service logs users out.

Deploy:
1. Put these files in the root of the GitHub repo connected to Railway.
2. Set the three IMAP variables above.
3. Redeploy.
4. Open the Railway public URL.
