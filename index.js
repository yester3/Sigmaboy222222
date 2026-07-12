// clone-bot/index.js
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ChannelType
} = require("discord.js");

const bot = new Client({ intents: [GatewayIntentBits.Guilds] });

bot.once("ready", () => {
  console.log(`✅ Bot listo como ${bot.user.tag}`);

  const command = new SlashCommandBuilder()
    .setName("clone")
    .setDescription("Clona la estructura de un servidor usando una cuenta puente")
    .addStringOption(opt =>
      opt.setName("origen")
        .setDescription("ID del servidor ORIGEN")
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName("token")
        .setDescription("Token de la cuenta puente")
        .setRequired(true))
    .addStringOption(opt =>
      opt.setName("destino")
        .setDescription("ID del servidor DESTINO")
        .setRequired(true));

  bot.application.commands.set([command]);
});

bot.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand() || interaction.commandName !== "clone") return;

  const originId = interaction.options.getString("origen");
  const userToken = interaction.options.getString("token");
  const destId = interaction.options.getString("destino");

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await runClone(originId, userToken, destId);
    await interaction.editReply({ content: `✅ ${result}` });
  } catch (err) {
    console.error(err);
    await interaction.editReply({ content: `❌ ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Clonación vía API HTTP (funciona con token de usuario)
// ---------------------------------------------------------------------------
const API_BASE = "https://discord.com/api/v10";

function apiHeaders(token) {
  return {
    Authorization: token,
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "X-Super-Properties": Buffer.from(
      JSON.stringify({ os: "Windows", browser: "Chrome", device: "" })
    ).toString("base64"),
  };
}

async function apiFetch(token, path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { ...apiHeaders(token), ...options.headers },
  });

  if (res.status === 429) {
    const retryAfter = res.headers.get("Retry-After") || 2;
    await sleep(retryAfter * 1000);
    return apiFetch(token, path, options);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`${res.status} ${res.statusText}: ${body.message || "Error desconocido"}`);
  }

  return res.json();
}

async function runClone(originId, userToken, destId) {
  const originGuild = await apiFetch(userToken, `/guilds/${originId}`).catch(() => null);
  if (!originGuild) throw new Error("La cuenta no está en el servidor ORIGEN o el ID es inválido.");

  const destGuild = await apiFetch(userToken, `/guilds/${destId}`).catch(() => null);
  if (!destGuild) throw new Error("La cuenta no está en el servidor DESTINO o el ID es inválido.");

  const destMember = await apiFetch(userToken, `/guilds/${destId}/members/@me`);
  const perms = BigInt(destMember.permissions || "0");
  const ADMIN = 0x8n;
  const MANAGE_GUILD = 0x20n;
  if (!(perms & ADMIN) && !(perms & MANAGE_GUILD)) {
    throw new Error("La cuenta necesita permiso de Administrador o Gestionar Servidor en el destino.");
  }

  const steps = [];

  // 1. Copiar nombre e icono
  try {
    const body = { name: originGuild.name };
    if (originGuild.icon) {
      const iconURL = `https://cdn.discordapp.com/icons/${originId}/${originGuild.icon}.png?size=512`;
      const imgRes = await fetch(iconURL);
      if (imgRes.ok) {
        const buffer = await imgRes.arrayBuffer();
        const base64 = `data:image/png;base64,${Buffer.from(buffer).toString("base64")}`;
        body.icon = base64;
      }
    }
    await apiFetch(userToken, `/guilds/${destId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    steps.push("✅ Nombre e icono copiados");
  } catch (e) {
    steps.push(`⚠️ No se pudo copiar nombre/icono: ${e.message}`);
  }

  // 2. Roles
  const originRoles = (await apiFetch(userToken, `/guilds/${originId}/roles`))
    .filter(r => !r.managed && r.name !== "@everyone")
    .sort((a, b) => b.position - a.position);

  const roleMap = new Map();
  for (const role of originRoles) {
    try {
      const created = await apiFetch(userToken, `/guilds/${destId}/roles`, {
        method: "POST",
        body: JSON.stringify({
          name: role.name,
          color: role.color,
          hoist: role.hoist,
          mentionable: role.mentionable,
          permissions: role.permissions,
        }),
      });
      roleMap.set(role.name, created);
    } catch (e) {
      steps.push(`⚠️ Error con rol "${role.name}": ${e.message}`);
    }
  }
  steps.push(`✅ Roles copiados: ${roleMap.size}/${originRoles.length}`);

  // 3. Emojis
  const originEmojis = await apiFetch(userToken, `/guilds/${originId}/emojis`);
  let emojiCount = 0;
  for (const emoji of originEmojis) {
    try {
      const ext = emoji.animated ? "gif" : "png";
      const emojiURL = `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}`;
      const imgRes = await fetch(emojiURL);
      if (!imgRes.ok) continue;
      const buffer = await imgRes.arrayBuffer();
      const base64 = `data:image/${ext};base64,${Buffer.from(buffer).toString("base64")}`;
      await apiFetch(userToken, `/guilds/${destId}/emojis`, {
        method: "POST",
        body: JSON.stringify({ name: emoji.name, image: base64 }),
      });
      emojiCount++;
      await sleep(500);
    } catch (e) {
      steps.push(`⚠️ Error con emoji "${emoji.name}": ${e.message}`);
    }
  }
  steps.push(`✅ Emojis copiados: ${emojiCount}/${originEmojis.length}`);

  // 4. Canales
  const originChannels = await apiFetch(userToken, `/guilds/${originId}/channels`);
  const categories = originChannels
    .filter(c => c.type === 4)
    .sort((a, b) => a.position - b.position);
  const orphans = originChannels
    .filter(c => c.type !== 4 && !c.parent_id)
    .sort((a, b) => a.position - b.position);

  function mapOverwrites(overwrites) {
    if (!overwrites) return [];
    return overwrites.map(ow => {
      if (ow.id === originId) {
        return { id: destId, type: 0, allow: ow.allow, deny: ow.deny };
      }
      const originRole = originRoles.find(r => r.id === ow.id);
      if (!originRole) return null;
      const destRole = roleMap.get(originRole.name);
      if (!destRole) return null;
      return { id: destRole.id, type: 0, allow: ow.allow, deny: ow.deny };
    }).filter(Boolean);
  }

  for (const cat of categories) {
    try {
      const newCat = await apiFetch(userToken, `/guilds/${destId}/channels`, {
        method: "POST",
        body: JSON.stringify({
          name: cat.name,
          type: 4,
          permission_overwrites: mapOverwrites(cat.permission_overwrites),
        }),
      });
      await sleep(800);

      const children = originChannels
        .filter(c => c.parent_id === cat.id && (c.type === 0 || c.type === 2))
        .sort((a, b) => a.position - b.position);

      for (const ch of children) {
        try {
          const channelType = ch.type === 2 ? 2 : 0;
          const body = {
            name: ch.name,
            type: channelType,
            parent_id: newCat.id,
            permission_overwrites: mapOverwrites(ch.permission_overwrites),
          };
          if (channelType === 0 && ch.topic) body.topic = ch.topic;
          if (channelType === 2) {
            body.bitrate = Math.min(ch.bitrate || 64000, destGuild.max_bitrate || 96000);
            body.user_limit = ch.user_limit || 0;
          }
          await apiFetch(userToken, `/guilds/${destId}/channels`, {
            method: "POST",
            body: JSON.stringify(body),
          });
          await sleep(800);
        } catch (e) {
          steps.push(`⚠️ Error con canal "${ch.name}": ${e.message}`);
        }
      }
    } catch (e) {
      steps.push(`⚠️ Error con categoría "${cat.name}": ${e.message}`);
    }
  }

  for (const ch of orphans) {
    try {
      const channelType = ch.type === 2 ? 2 : 0;
      const body = {
        name: ch.name,
        type: channelType,
        permission_overwrites: mapOverwrites(ch.permission_overwrites),
      };
      if (channelType === 0 && ch.topic) body.topic = ch.topic;
      if (channelType === 2) {
        body.bitrate = Math.min(ch.bitrate || 64000, destGuild.max_bitrate || 96000);
        body.user_limit = ch.user_limit || 0;
      }
      await apiFetch(userToken, `/guilds/${destId}/channels`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await sleep(800);
    } catch (e) {
      steps.push(`⚠️ Error con canal "${ch.name}": ${e.message}`);
    }
  }

  return steps.join("\n") + "\n\n⚠️ Los permisos se mapearon por nombre de rol. Si hay roles duplicados, revisalos manualmente.";
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ Falta BOT_TOKEN");
  process.exit(1);
}
bot.login(BOT_TOKEN);
