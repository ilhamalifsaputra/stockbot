import { Telegraf, Markup } from "telegraf";
import fs from "fs-extra";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { fileURLToPath } from "url";
import path from "path";

dotenv.config();

const bot = new Telegraf(process.env.BOT_TOKEN);

// ===== CONFIG =====
const ADMINS = [5840513237]; // Admin Telegram ID
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STOCK_DIR = path.join(__dirname, "stock");       // Fix Bug #1: path absolut
const SESSION_FILE = path.join(__dirname, "sessions.json"); // Fix Bug #2: persistent session

// ===== GUARD =====
function adminOnly(ctx) {
  if (!ADMINS.includes(ctx.from?.id)) {
    ctx.reply("⛔ Akses ditolak.");
    return false;
  }
  return true;
}

// ===== PERSISTENT SESSION =====  Fix Bug #2
function getSession(userId) {
  if (!fs.existsSync(SESSION_FILE)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    return data[String(userId)] || null;
  } catch {
    return null;
  }
}

function setSession(userId, data) {
  let sessions = {};
  if (fs.existsSync(SESSION_FILE)) {
    try { sessions = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8")); } catch {}
  }
  sessions[String(userId)] = data;
  fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
}

function deleteSession(userId) {
  if (!fs.existsSync(SESSION_FILE)) return;
  try {
    const sessions = JSON.parse(fs.readFileSync(SESSION_FILE, "utf8"));
    delete sessions[String(userId)];
    fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
  } catch {}
}

// ===== UTIL =====
function formatNumberID(n) {
  return new Intl.NumberFormat("id-ID").format(n);
}

function getProducts() {
  if (!fs.existsSync(STOCK_DIR)) return [];
  return fs.readdirSync(STOCK_DIR)
    .filter(f => f.endsWith(".txt"))
    .map(f => f.replace(".txt", ""))
    .sort();
}

function readStockLines(product) {
  const file = path.join(STOCK_DIR, `${product}.txt`);
  if (!fs.existsSync(file)) return [];
  const raw = fs.readFileSync(file, "utf8");
  return raw
    .replace(/\uFEFF/g, "")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(x => x.length > 0);
}

function writeStockLines(product, lines) {
  const file = path.join(STOCK_DIR, `${product}.txt`);
  fs.writeFileSync(file, lines.join("\n"));
}

function getStockCount(product) {
  return readStockLines(product).length;
}

function takeStock(product, amount) {
  const lines = readStockLines(product);
  if (lines.length < amount) return null;

  const taken = lines.splice(0, amount);
  writeStockLines(product, lines);
  return taken.join("\n");
}

// ===== RENDER HELPERS =====
async function renderHome(ctx) {
  const products = getProducts();

  // Fix Bug #5: edit pesan jika dipanggil dari callback, reply jika dari command
  const send = ctx.callbackQuery
    ? (text, extra) => ctx.editMessageText(text, extra)
    : (text, extra) => ctx.reply(text, extra);

  if (products.length === 0) {
    return send(
      "👋 Halo, Admin.\n\n" +
      "⚠️ Belum ada produk terdaftar.\n\n" +
      "Gunakan tombol di bawah untuk membuat produk pertama.",
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Create Product", "create_product_btn")]
      ])
    );
  }

  const buttons = products.map(p => [Markup.button.callback(p.toUpperCase(), `pick_${p}`)]);
  buttons.push([Markup.button.callback("📦 Cek Semua Stok", "allstock_btn")]);
  buttons.push([Markup.button.callback("➕ Create Product", "create_product_btn")]);

  return send(
    "👋 Halo, Admin.\n\nPilih produk atau aksi:",
    Markup.inlineKeyboard(buttons)
  );
}

async function renderProductPanel(ctx, product) {
  const stock = getStockCount(product);
  const stockFmt = formatNumberID(stock);

  if (stock === 0) {
    return ctx.editMessageText(
      `📦 Produk: ${product.toUpperCase()}\nStok: ${stockFmt} ⚠️\n\nStok kosong.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Tambah Stok", `add_${product}`)],
        [Markup.button.callback("⬅️ Kembali", "back_home")]
      ])
    );
  }

  return ctx.editMessageText(
    `📦 Produk: ${product.toUpperCase()}\nStok tersedia: ${stockFmt}\n\nPilih aksi:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("📤 Ambil Stok", `take_${product}`)],
      [Markup.button.callback("➕ Tambah Stok", `add_${product}`)],
      [Markup.button.callback("🗑️ Kurangi Stok", `remove_${product}`)],
      [Markup.button.callback("⬅️ Kembali", "back_home")]
    ])
  );
}

// ===== START =====
bot.start(async (ctx) => {
  if (!adminOnly(ctx)) return;
  await renderHome(ctx);
});

// ===== ALL STOCK (BUTTON + COMMAND) =====
async function replyAllStock(ctx) {
  const products = getProducts();
  if (products.length === 0) {
    return ctx.reply("⚠️ Belum ada produk terdaftar.");
  }
  const lines = products.map(p => {
    const c = getStockCount(p);
    return `${p.toUpperCase()}: ${formatNumberID(c)}${c === 0 ? " ⚠️" : ""}`;
  });
  return ctx.reply("📊 Laporan Stok Semua Produk\n\n" + lines.join("\n"));
}

bot.action("allstock_btn", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery(); // Fix Bug #4
  await replyAllStock(ctx);
});

bot.command("allstock", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await replyAllStock(ctx);
});

// ===== CREATE PRODUCT (BUTTON) =====
bot.action("create_product_btn", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery(); // Fix Bug #4
  setSession(ctx.from.id, { step: "input_product_name" });
  await ctx.reply("Masukkan nama produk:");
});

// ===== PICK PRODUCT =====
bot.action(/^pick_(.+)$/, async (ctx) => {  // Fix Bug #3: regex dianchor
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery(); // Fix Bug #4
  const product = ctx.match[1];
  setSession(ctx.from.id, { product });
  await renderProductPanel(ctx, product);
});

// ===== BACK =====
bot.action("back_home", async (ctx) => {
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery(); // Fix Bug #4
  deleteSession(ctx.from.id);
  await renderHome(ctx);
});

bot.action(/^back_product_(.+)$/, async (ctx) => {  // Fix Bug #3: regex dianchor
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery(); // Fix Bug #4
  const product = ctx.match[1];
  setSession(ctx.from.id, { product });
  await renderProductPanel(ctx, product);
});

// ===== TAKE =====
bot.action(/^take_(.+)$/, async (ctx) => {  // Fix Bug #3: regex dianchor
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery(); // Fix Bug #4

  const product = ctx.match[1];
  const stock = getStockCount(product);
  if (stock === 0) {
    return ctx.reply(`⚠️ Stok ${product.toUpperCase()} kosong.`);
  }

  setSession(ctx.from.id, { product, step: "input_qty_take" });
  await ctx.reply(
    `Masukkan jumlah ${product} yang ingin diambil (angka saja):`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", `back_product_${product}`)]])
  );
});

// ===== REMOVE =====
bot.action(/^remove_(.+)$/, async (ctx) => {  // Fix Bug #3: regex dianchor
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery(); // Fix Bug #4

  const product = ctx.match[1];
  setSession(ctx.from.id, { product, step: "input_qty_remove" });
  await ctx.reply(
    `Masukkan jumlah ${product} yang ingin dikurangi (angka saja):`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", `back_product_${product}`)]])
  );
});

// ===== ADD (UPLOAD MODE) =====
bot.action(/^add_(.+)$/, async (ctx) => {  // Fix Bug #3: regex dianchor
  if (!adminOnly(ctx)) return;
  await ctx.answerCbQuery(); // Fix Bug #4

  const product = ctx.match[1];
  setSession(ctx.from.id, { product, step: "upload_stock" });
  await ctx.reply(
    `Upload file .txt untuk produk ${product.toUpperCase()} (RAW MODE):`,
    Markup.inlineKeyboard([[Markup.button.callback("⬅️ Kembali", `back_product_${product}`)]])
  );
});

// ===== HANDLE TEXT =====
bot.on("text", async (ctx) => {
  if (!adminOnly(ctx)) return;

  const session = getSession(ctx.from.id);
  if (!session) return;

  // CREATE PRODUCT FLOW
  if (session.step === "input_product_name") {
    const product = ctx.message.text.trim().toLowerCase().replace(/\s+/g, "-");
    if (!product) return ctx.reply("Nama produk tidak boleh kosong.");

    await fs.ensureDir(STOCK_DIR);
    const file = path.join(STOCK_DIR, `${product}.txt`);
    if (fs.existsSync(file)) {
      return ctx.reply(`❌ Produk ${product.toUpperCase()} sudah ada.`);
    }

    await fs.writeFile(file, "");
    deleteSession(ctx.from.id);

    const stock = getStockCount(product);
    return ctx.reply(
      `✅ Produk ${product.toUpperCase()} berhasil dibuat (stok ${formatNumberID(stock)}).\n\n` +
      `📦 Produk: ${product.toUpperCase()}\n` +
      `Stok: ${formatNumberID(stock)} ⚠️`,
      Markup.inlineKeyboard([
        [Markup.button.callback("➕ Tambah Stok", `add_${product}`)],
        [Markup.button.callback("⬅️ Kembali", "back_home")]
      ])
    );
  }

  // Fix Bug #7: guard — abaikan jika step bukan take/remove
  if (session.step !== "input_qty_take" && session.step !== "input_qty_remove") return;

  // TAKE / REMOVE FLOW
  const qty = parseInt(ctx.message.text);
  if (isNaN(qty) || qty <= 0) {
    return ctx.reply("❌ Masukkan angka yang valid.");
  }

  const stock = getStockCount(session.product);

  if (session.step === "input_qty_take") {
    if (qty > stock) {
      return ctx.reply(`❌ Stok tidak mencukupi. Tersedia: ${formatNumberID(stock)}`);
    }

    const result = takeStock(session.product, qty);
    deleteSession(ctx.from.id);

    const mdEscape = (t) => t.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
    const formatted = result
      .split("\n")
      .map(line => `\`${mdEscape(line)}\``)
      .join("\n");

    return ctx.reply(
      `✅ Berhasil mengambil ${formatNumberID(qty)} stok ${session.product.toUpperCase()}:\n\n${formatted}`,
      { parse_mode: "MarkdownV2" }
    );
  }

  if (session.step === "input_qty_remove") {
    const lines = readStockLines(session.product);
    lines.splice(0, qty);
    writeStockLines(session.product, lines);

    deleteSession(ctx.from.id);
    return ctx.reply(`✅ Berhasil mengurangi ${formatNumberID(qty)} stok ${session.product.toUpperCase()}.`);
  }
});

// ===== HANDLE FILE UPLOAD (RAW MODE) =====
bot.on("document", async (ctx) => {
  if (!adminOnly(ctx)) return;

  const session = getSession(ctx.from.id);
  if (!session || session.step !== "upload_stock") {
    return ctx.reply("Gunakan panel produk untuk upload stok.");
  }

  const link = await ctx.telegram.getFileLink(ctx.message.document.file_id);
  const res = await fetch(link.href);
  const text = await res.text();

  const newLines = text
    .replace(/\uFEFF/g, "")
    .split(/\r?\n/)
    .map(x => x.trim())
    .filter(x => x.length > 0);

  if (newLines.length === 0) {
    return ctx.reply("❌ File kosong. Tidak ada stok yang ditambahkan.");
  }

  const existing = readStockLines(session.product);
  const merged = existing.concat(newLines);
  writeStockLines(session.product, merged);

  const total = merged.length;
  deleteSession(ctx.from.id);

  ctx.reply(`✅ Stok ${session.product.toUpperCase()} berhasil ditambahkan.\nTotal stok sekarang: ${formatNumberID(total)}`);
});

bot.launch();
console.log("Bot running...");

// Fix Bug #6: graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
