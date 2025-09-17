import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import express from 'express';
import pkg from 'pg';

const { Pool } = pkg;

// ====== PostgreSQL Pool (Neon用) ======
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // NeonはSSL必須
});

// ====== DB操作関数 ======
async function saveCount(userId, counts) {
  await pool.query(
    `INSERT INTO counts (user_id, kiremono, ritaiya, kirenashi, nickname_changes)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id)
     DO UPDATE SET kiremono=$2, ritaiya=$3, kirenashi=$4, nickname_changes=$5`,
    [userId, counts.kiremono, counts.ritaiya, counts.kirenashi, counts.nicknameChanges]
  );
}

async function loadCount(userId) {
  const { rows } = await pool.query('SELECT * FROM counts WHERE user_id=$1', [userId]);
  if (rows.length === 0) return { kiremono:0, ritaiya:0, kirenashi:0, nicknameChanges:0 };
  const r = rows[0];
  return {
    kiremono: r.kiremono,
    ritaiya: r.ritaiya,
    kirenashi: r.kirenashi,
    nicknameChanges: r.nickname_changes,
  };
}

// ====== Discord Bot 設定 ======
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const userWordCounts = {};
const renameMap = new Map();
const WORDS = { kiremono: 'きれもの', ritaiya: 'りたいあ', kirenashi: 'きれなし' };
const randomReplies = [
  '窓をお開け！全部だよ！！', 
  'やはり！さぁ、きばるんだよ！',
  'んん……？？',
  'あぁああごめんごめん、いい子でおねんねしてたのにねぇ。ばぁばはまだお仕事があるの。いいこでおねんねしててねぇ～。',
  'ヒッ！？ ',
  'うるさいね、静かにしておくれ。',
  'だァーーーまァーーーれェーーー！！！',
  '大きな声を出すんじゃない……うっ！あー、ちょっと待ちなさい、ね、ねぇ～。いい子だから、ほぉらほら～。',
  '四の五の言うと、石炭にしちまうよ。わかったね！',
  'なぁんだいおまえ。生きてたのかい。',
  'ずいぶん生意気な口を利くね。いつからそんなに偉くなったんだい？',
  'フン！',
];

// ready → clientReady に変更
client.once('clientReady', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

// メッセージ監視
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== TARGET_CHANNEL_ID) return;

  const uid = message.author.id;

  if (!userWordCounts[uid]) userWordCounts[uid] = await loadCount(uid);

  // --- ニックネーム変更 ---
  if (message.mentions.has(client.user) && message.content.includes('切れ者')) {
    const member = message.member;
    if (!member) return;
    const oldNick = member.nickname || member.user.username;
    const percent = Math.floor(Math.random()*121);
    const newNick = `切れ者確率${percent}%`;

    renameMap.set(member.id, oldNick);
    userWordCounts[uid].nicknameChanges += 1;
    await saveCount(uid, userWordCounts[uid]);

    await member.setNickname(newNick).catch(console.error);
    await message.channel.send(
      `**お前は${userWordCounts[uid].nicknameChanges}回目の入浴だねぇ。**\n` +
      `**フン。ようやく準備ができたのかい。\n${oldNick}というのかい。贅沢な名だねぇ。\n` +
      `今からお前の名は${newNick} だ。\nいいかい？${newNick}だ。\n` +
      `分かったら返事をするんだ、${newNick}！！**`
    );
    return;
  }

  // --- 画像投稿で元に戻す ---
  if (renameMap.has(uid) && message.attachments.size > 0) {
    const member = message.member;
    const oldNick = renameMap.get(uid);
    await member.setNickname(oldNick).catch(console.error);
    renameMap.delete(uid);
    await message.channel.send('**それがお前の答えかい？\nいきな！\nお前の勝ちだ！\n早くいっちまいな！！\nフン！**');
    return;
  }

  // --- ワード集計 ---
  let matchedWord = null;
  for (const [key, word] of Object.entries(WORDS)) {
    if (message.content.includes(word)) {
      userWordCounts[uid][key] += 1;
      matchedWord = key;
    }
  }

  if (matchedWord) {
    await saveCount(uid, userWordCounts[uid]);
    const reply = randomReplies[Math.floor(Math.random() * randomReplies.length)];
    const count = userWordCounts[uid][matchedWord];
    const label = WORDS[matchedWord];
    await message.channel.send(`**${label}${count}回目だね。 ${reply}**`);
  }

  // --- 集計発表 ---
  if (message.mentions.has(client.user) && message.content.includes('集計')) {
    const c = userWordCounts[uid];
    const total = c.kiremono + c.ritaiya + c.kirenashi;
    await message.channel.send(
      `**フン！\nまったく、手がかかるトレーナーだねぇ。\n\n` +
      `${message.member.displayName}というやつだね。\n` +
      `きれもの...${c.kiremono}回\n` +
      `りたいあ...${c.ritaiya}回\n` +
      `きれなし...${c.kirenashi}回\n` +
      `合計...${total}回\n\n` +
      `わかったらとっとと湯に戻りな！フン！**`
    );
    return;
  }

  // --- 集計リセット ---
  if (message.mentions.has(client.user) && message.content.includes('バルス')) {
    userWordCounts[uid] = { kiremono:0, ritaiya:0, kirenashi:0, nicknameChanges:0 };
    await saveCount(uid, userWordCounts[uid]);
    await message.channel.send('**集計をリセットしたよ、フン！**');
  }
});

// Discord Bot ログイン
client.login(process.env.DISCORD_TOKEN);

// ===== Render用 ダミーHTTPサーバー =====
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (_, res) => res.send('Discord bot is running!'));
app.listen(PORT, () => console.log(`🌐 Dummy HTTP server listening on port ${PORT}`));
