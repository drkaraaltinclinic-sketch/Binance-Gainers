// mailer.js
// BINANCE GAINERS' own HERALD sender — separate nodemailer instance from
// SUPREME-LEADER's, so this fires independently whenever you press the
// button, regardless of what the other 24 agents are doing.

const nodemailer = require("nodemailer");

function getTransport() {
  const user = process.env.HERALD_GMAIL_USER;
  const pass = process.env.HERALD_GMAIL_APP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    service: "gmail",
    auth: { user, pass },
  });
}

function formatReportHtml(report) {
  const rows = report.tokens
    .map((t) => {
      if (!t.cleared) {
        return `<tr><td colspan="5" style="padding:8px;border-bottom:1px solid #333;color:#999;">
          <b>${t.ticker}</b> — skipped (${t.vetoes.join("; ")})</td></tr>`;
      }
      const s = t.setup;
      return `
        <tr>
          <td style="padding:8px;border-bottom:1px solid #333;"><b>${t.ticker}</b></td>
          <td style="padding:8px;border-bottom:1px solid #333;">Squeeze: ${t.squeeze.label} (${t.squeeze.score})</td>
          <td style="padding:8px;border-bottom:1px solid #333;">Entries: ${s.entries
            .map((e) => e.price)
            .join(" / ")}</td>
          <td style="padding:8px;border-bottom:1px solid #333;">SL: ${s.stopLoss}</td>
          <td style="padding:8px;border-bottom:1px solid #333;">TP: ${s.takeProfit.join(" / ")}</td>
        </tr>`;
    })
    .join("");

  return `
    <div style="font-family:monospace;background:#0a0b0d;color:#e6e4df;padding:20px;">
      <h2 style="color:#d9a441;">BINANCE GAINERS — Scan Report</h2>
      <p style="color:#797e87;">${new Date(report.generatedAt).toLocaleString()}</p>
      <table style="border-collapse:collapse;width:100%;">${rows}</table>
      <p style="color:#797e87;margin-top:16px;">Manual review only — no auto-execution. Check current market conditions on Binance before entering.</p>
    </div>`;
}

async function sendHeraldReport(report) {
  const transport = getTransport();
  if (!transport) {
    return { ok: false, reason: "HERALD_GMAIL_USER / HERALD_GMAIL_APP_PASSWORD not set" };
  }
  const to = process.env.HERALD_RECIPIENT || process.env.HERALD_GMAIL_USER;
  try {
    await transport.sendMail({
      from: process.env.HERALD_GMAIL_USER,
      to,
      subject: `BINANCE GAINERS Scan Report — ${new Date(report.generatedAt).toLocaleDateString()}`,
      html: formatReportHtml(report),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

async function sendSpoofAlert(detection) {
  const transport = getTransport();
  if (!transport) {
    return { ok: false, reason: "HERALD_GMAIL_USER / HERALD_GMAIL_APP_PASSWORD not set" };
  }
  const to = process.env.HERALD_RECIPIENT || process.env.HERALD_GMAIL_USER;
  const html = `
    <div style="font-family:monospace;background:#0a0b0d;color:#e6e4df;padding:20px;">
      <h2 style="color:#e0473d;">⚠ POSSIBLE ORDER BOOK SPOOF — ${detection.symbol}</h2>
      <p style="color:#797e87;">${detection.detectedAt}</p>
      <p>A large ${detection.side === 'bid' ? 'buy' : 'sell'} order at <b>${detection.price}</b> (size ${detection.vanishedQty.toFixed(0)}) vanished from the order book,
      but only ${detection.tradedVolumeSince.toFixed(0)} actually traded since it appeared — far less than what disappeared.</p>
      <p style="color:#797e87;">This is a heuristic pattern match (order gone, not filled by real volume) — not confirmed manipulation. Worth a manual look at the live chart before acting on it.</p>
    </div>`;
  try {
    await transport.sendMail({
      from: process.env.HERALD_GMAIL_USER,
      to,
      subject: `⚠ Possible spoof detected — ${detection.symbol}`,
      html,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

module.exports = { sendHeraldReport, sendSpoofAlert };
