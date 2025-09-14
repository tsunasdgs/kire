import 'dotenv/config';
import { Client, GatewayIntentBits, Events, bold } from 'discord.js';
import express from 'express';   // ← 追加

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;
const nicknameMap = new Map();

client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channel.id !== TARGET_CHANNEL_ID) return;

  const isBotMentioned =
    message.mentions.has(client.user) && message.mentions.users.size === 1;

  if (isBotMentioned && message.content.includes('切れ者')) {
    const member = message.member;
    if (!member) return;

    const rate = Math.floor(Math.random() * 120) + 1;
    const oldNick = member.nickname || member.user.username;
    const newNick = `切れ者確率${rate}%`;
    nicknameMap.set(member.id, oldNick);

    try {
      await member.setNickname(newNick);
      await message.channel.send(bold(
        `フン。ようやく準備ができたのかい。\n` +
        `${oldNick}というのかい。贅沢な名だねぇ。\n` +
        `今からお前の名は${newNick} だ。\n` +
        `いいかい？${newNick}だ。\n` +
        `分かったら返事をするんだ、${newNick}！！`
      ));
    } catch (err) {
      console.error(err);
      message.channel.send('ニックネーム変更に失敗しました。権限を確認してください。');
    }
  } else if (nicknameMap.has(message.author.id) && message.attachments.size > 0) {
    const member = message.member;
    if (!member) return;

    const oldNick = nicknameMap.get(message.author.id);
    nicknameMap.delete(message.author.id);

    try {
      await member.setNickname(oldNick);
      await message.channel.send(bold(
        `それがお前の答えかい？\n` +
        `いきな！\n` +
        `お前の勝ちだ！\n` +
        `早くいっちまいな！！\n` +
        `フン！`
      ));
    } catch (err) {
      console.error(err);
    }
  }
});

client.login(process.env.DISCORD_TOKEN);

// ---------- ここから追加 ---------- //
const app = express();
const PORT = process.env.PORT || 3000;

// Render がポートを検知できるようにダミーエンドポイント
app.get('/', (_, res) => res.send('Discord bot is running!'));

app.listen(PORT, () => {
  console.log(`🌐 Express server listening on port ${PORT}`);
});
// ---------- 追加ここまで ---------- //
