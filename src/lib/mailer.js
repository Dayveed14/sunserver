import { Resend } from 'resend';

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createMailer({ apiKey, from, isProd }) {
  const client = apiKey ? new Resend(apiKey) : null;

  return {
    async sendOtp({ to, name, code, ttlMinutes }) {
      const subject = `${code} is your Sunledger verification code`;
      const text =
        `Hi ${name},\n\nYour Sunledger verification code is ${code}.\n` +
        `It expires in ${ttlMinutes} minutes. If you didn't try to sign up, you can ignore this email.\n`;
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:420px;margin:0 auto;padding:24px;color:#10141f">
          <p style="font-size:15px;margin:0 0 16px">Hi ${escapeHtml(name)},</p>
          <p style="font-size:15px;margin:0 0 20px">Use this code to verify your email and finish creating your Sunledger account:</p>
          <p style="font-size:34px;font-weight:700;letter-spacing:8px;margin:0 0 20px;color:#b4700a">${escapeHtml(code)}</p>
          <p style="font-size:13px;color:#5b6172;margin:0">It expires in ${ttlMinutes} minutes. If you didn't try to sign up, you can ignore this email.</p>
        </div>`;

      if (!client) {
        if (isProd) throw new Error('RESEND_API_KEY is not configured');
        console.log(`[mail:dev] Verification code for ${to}: ${code}`);
        return { delivered: false };
      }

      const { error } = await client.emails.send({ from, to: [to], subject, html, text });
      if (error) throw new Error(error.message ?? 'Resend rejected the email');
      return { delivered: true };
    },

    async sendPasswordReset({ to, name, link, ttlMinutes }) {
      const subject = 'Reset your Sunledger password';
      const text =
        `Hi ${name},\n\nSomeone asked to reset the password for your Sunledger account. Open this link to choose a new one:\n${link}\n\n` +
        `It works once and expires in ${ttlMinutes} minutes. If this wasn't you, ignore this email: your password stays the same.\n`;
      const html = `
        <div style="font-family:Arial,Helvetica,sans-serif;max-width:460px;margin:0 auto;padding:24px;color:#10141f">
          <p style="font-size:15px;margin:0 0 16px">Hi ${escapeHtml(name)},</p>
          <p style="font-size:15px;margin:0 0 20px">Someone asked to reset the password for your Sunledger account.</p>
          <p style="margin:0 0 20px"><a href="${escapeHtml(link)}" style="background:#b4700a;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Choose a new password</a></p>
          <p style="font-size:13px;color:#5b6172;margin:0">The link works once and expires in ${ttlMinutes} minutes. If this wasn't you, ignore this email: your password stays the same.</p>
        </div>`;

      if (!client) {
        if (isProd) throw new Error('RESEND_API_KEY is not configured');
        console.log(`[mail:dev] Password reset link for ${to}: ${link}`);
        return { delivered: false };
      }
      const { error } = await client.emails.send({ from, to: [to], subject, html, text });
      if (error) throw new Error(error.message ?? 'Resend rejected the email');
      return { delivered: true };
    },
  };
}
