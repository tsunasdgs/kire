import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import express from 'express';   // ★Render対応のため追加

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ],
});

const GUILD_ID = process.env.GUILD_ID;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;

// 各ユーザーのカウント
// { userId: { kiremono:0, ritaiya:0, kirenashi:0, nicknameChanges:0 } }
const userWordCounts = {};
const renameMap = new Map(); // { userId: oldNickname }

const WORDS = {
  kiremono: 'きれもの',
  ritaiya: 'りたいあ',
  kirenashi: 'きれなし',
};

const randomReplies = [
  'うるさいね、静かにしておくれ。',
  'だァーーーまァーーーれェーーー！！！',
  '大きな声を出すんじゃない……うっ！あー、ちょっと待ちなさい、ね、ねぇ～。いい子だから、ほぉらほら～。',
  '四の五の言うと、石炭にしちまうよ。わかったね！',
  'なぁんだいおまえ。生きてたのかい。',
  'ずいぶん生意気な口を利くね。いつからそんなに偉くなったんだい？',
  'フン！',
];

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== TARGET_CHANNEL_ID) return;

  const uid = message.author.id;
  if (!userWordCounts[uid]) {
    userWordCounts[uid] = { kiremono: 0, ritaiya: 0, kirenashi: 0, nicknameChanges: 0 };
  }

  // --- ニックネーム変更 ---
  if (message.mentions.has(client.user) && message.content.includes('切れ者')) {
    const member = message.member;
    if (!member) return;

    const oldNick = member.nickname || member.user.username;
    const percent = Math.floor(Math.random() * 121); // 0～120
    const newNick = `切れ者確率${percent}%`;

    renameMap.set(member.id, oldNick);

    // ニックネーム変更回数をカウント
    userWordCounts[uid].nicknameChanges += 1;
    const bathCount = userWordCounts[uid].nicknameChanges;

    await member.setNickname(newNick).catch(console.error);

    await message.channel.send(
      `**お前は${bathCount}回目の入浴だねぇ。**\n\n` +  // ← 先頭に移動
      `**フン。ようやく準備ができたのかい。\n` +
      `${oldNick}というのかい。贅沢な名だねぇ。\n` +
      `今からお前の名は${newNick} だ。\n` +
      `いいかい？${newNick}だ。\n` +
      `分かったら返事をするんだ、${newNick}！！**`
    );
    return;
  }

  // --- 画像投稿で元に戻す ---
  if (renameMap.has(message.author.id) && message.attachments.size > 0) {
    const member = message.member;
    const oldNick = renameMap.get(message.author.id);
    await member.setNickname(oldNick).catch(console.error);
    renameMap.delete(message.author.id);

    await message.channel.send(
      `**それがお前の答えかい？\nいきな！\nお前の勝ちだ！\n早くいっちまいな！！\nフン！**`
    );
    return;
  }

  // --- ワード集計 & カウント付き返信 ---
  let matchedWord = null;
  const content = message.content;

  for (const [key, word] of Object.entries(WORDS)) {
    if (content.includes(word)) {
      userWordCounts[uid][key] += 1;
      matchedWord = key;
    }
  }

  if (matchedWord) {
    const reply = randomReplies[Math.floor(Math.random() * randomReplies.length)];
    const count = userWordCounts[uid][matchedWord];
    const label = WORDS[matchedWord];
    await message.channel.send(`**${label}${count}回目だね。 ${reply}**`);
  }

  // --- 集計発表 ---
  if (message.mentions.has(client.user) && content.includes('集計')) {
    const c = userWordCounts[uid];
    const total = c.kiremono + c.ritaiya + c.kirenashi;

    await message.channel.send(
      `**フン！\nまったく、手がかかるトレーナーだねぇ。\n\n` +
      `${message.member.displayName}というやつだね。\n` +
      `きれもの...${c.kiremono}回\n` +
      `りたいあ...${c.ritaiya}回\n` +
      `きれなし...${c.kirenashi}回\n` +
      `ニックネーム変更...${c.nicknameChanges}回\n` +
      `合計...${total}回\n\n` +
      `わかったらとっとと湯に戻りな！フン！**`
    );
    return;
  }

  // --- 集計リセット（ニックネーム変更回数も含む） ---
  if (message.mentions.has(client.user) && content.includes('バルス')) {
    Object.keys(userWordCounts).forEach((k) => delete userWordCounts[k]);
    await message.channel.send('**集計をリセットしたよ、フン！**');
  }
});

client.login(process.env.DISCORD_TOKEN);

// ====== ★Render用 ダミーHTTPサーバー ====== //
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_, res) => {
  res.send('Discord bot is running!');
});

app.listen(PORT, () => {
  console.log(`🌐 Dummy HTTP server listening on port ${PORT}`);
});
