// clone-bot/index.js
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ActionRowBuilder,
  PermissionFlagsBits,
  ChannelType
} = require("discord.js");

// ---------------------------------------------------------------------------
// Bot principal – solo responde al comando /clone
// ---------------------------------------------------------------------------
const bot = new Client({
  intents: [GatewayIntentBits.Guilds],
});

bot.once("ready", () => {
  console.log(`✅ Bot listo como ${bot.user.tag}`);

  const command = new SlashCommandBuilder()
    .setName("clone")
    .setDescription("Clona la estructura de un servidor usando una cuenta puente");

  bot.application.commands.set([command]);
});

// ---------------------------------------------------------------------------
// Mostrar el modal al usar /clone
// ---------------------------------------------------------------------------
bot.on("interactionCreate", async (interaction) => {
  if (!interaction.isCommand()) return;
  if (interaction.commandName !== "clone") return;

  const modal = new ModalBuilder()
    .setCustomId("clone-modal")
    .setTitle("Clonar servidor");

  const originInput = new TextInputBuilder()
    .setCustomId("origin-id")
    .setLabel("ID del servidor ORIGEN (a copiar)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const tokenInput = new TextInputBuilder()
    .setCustomId("user-token")
    .setLabel("Token de la cuenta puente")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  const destInput = new TextInputBuilder()
    .setCustomId("dest-id")
    .setLabel("ID del servidor DESTINO (donde pegar)")
    .setStyle(TextInputStyle.Short)
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(originInput),
    new ActionRowBuilder().addComponents(tokenInput),
    new ActionRowBuilder().addComponents(destInput)
  );

  await interaction.showModal(modal);
});

// ---------------------------------------------------------------------------
// Recibir el modal y ejecutar la clonación
// ---------------------------------------------------------------------------
bot.on("interactionCreate", async (interaction) => {
  if (!interaction.isModalSubmit()) return;
  if (interaction.customId !== "clone-modal") return;

  const originId = interaction.fields.getTextInputValue("origin-id");
  const userToken = interaction.fields.getTextInputValue("user-token");
  const destId = interaction.fields.getTextInputValue("dest-id");

  await interaction.deferReply({ ephemeral: true });

  try {
    const result = await runClone(originId, userToken, destId);
    await interaction.editReply({ content: `✅ ${result}` });
  } catch (err) {
    console.error(err);
    await interaction.editReply({
      content: `❌ Error: ${err.message}`,
    });
  }
});

// ---------------------------------------------------------------------------
// Lógica de clonación
// ---------------------------------------------------------------------------
async function runClone(originId, userToken, destId) {
  const userClient = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildEmojisAndStickers,
    ],
  });

  // Login con token de usuario
  await userClient.login(userToken).catch((e) => {
    userClient.destroy();
    throw new Error(`Token inválido o no se pudo iniciar sesión: ${e.message}`);
  });

  // Esperar ready
  await new Promise((resolve) => userClient.once("ready", resolve));

  const originGuild = userClient.guilds.cache.get(originId);
  const destGuild = userClient.guilds.cache.get(destId);

  if (!originGuild) {
    userClient.destroy();
    throw new Error("La cuenta puente no está en el servidor ORIGEN (ID no encontrado).");
  }
  if (!destGuild) {
    userClient.destroy();
    throw new Error("La cuenta puente no está en el servidor DESTINO (ID no encontrado).");
  }

  const destMember = destGuild.members.me;
  if (!destMember.permissions.has(PermissionFlagsBits.Administrator)) {
    userClient.destroy();
    throw new Error("La cuenta puente necesita permiso de ADMINISTRADOR en el servidor destino.");
  }

  const steps = [];

  // ----- 1. Copiar nombre e icono -----
  try {
    const iconURL = originGuild.iconURL({ format: "png", size: 512 });
    let iconData = null;
    if (iconURL) {
      const res = await fetch(iconURL);
      if (res.ok) iconData = Buffer.from(await res.arrayBuffer());
    }
    await destGuild.edit({
      name: originGuild.name,
      icon: iconData || null,
    });
    steps.push("✅ Nombre e icono copiados");
  } catch (e) {
    steps.push(`⚠️ No se pudo copiar nombre/icono: ${e.message}`);
  }

  // ----- 2. Copiar roles (mapear por nombre) -----
  const roles = originGuild.roles.cache
    .filter((r) => !r.managed && r.name !== "@everyone")
    .sort((a, b) => b.position - a.position);

  const roleNameMap = new Map(); // name -> role en destino
  for (const [, role] of roles) {
    try {
      const existing = destGuild.roles.cache.find((r) => r.name === role.name);
      if (existing) {
        roleNameMap.set(role.name, existing);
        await existing.setPermissions(role.permissions.bitfield);
        await existing.setColor(role.color);
        await existing.setHoist(role.hoist);
        await existing.setMentionable(role.mentionable);
      } else {
        const newRole = await destGuild.roles.create({
          name: role.name,
          color: role.color,
          hoist: role.hoist,
          mentionable: role.mentionable,
          permissions: role.permissions.bitfield,
        });
        roleNameMap.set(role.name, newRole);
      }
    } catch (e) {
      steps.push(`⚠️ Error con rol "${role.name}": ${e.message}`);
    }
  }
  steps.push(`✅ Roles copiados: ${roleNameMap.size}/${roles.size}`);

  // ----- 3. Copiar emojis -----
  const emojis = originGuild.emojis.cache;
  let emojiCount = 0;
  for (const [, emoji] of emojis) {
    try {
      const existing = destGuild.emojis.cache.find((e) => e.name === emoji.name);
      if (!existing) {
        const res = await fetch(emoji.url);
        if (res.ok) {
          const buffer = Buffer.from(await res.arrayBuffer());
          await destGuild.emojis.create({
            name: emoji.name,
            attachment: buffer,
          });
          emojiCount++;
        }
      }
      await sleep(500);
    } catch (e) {
      steps.push(`⚠️ Error con emoji "${emoji.name}": ${e.message}`);
    }
  }
  steps.push(`✅ Emojis copiados: ${emojiCount}/${emojis.size}`);

  // ----- Función auxiliar para convertir overwrites usando nombres de rol -----
  function mapOverwrites(overwrites, originGuildId, destGuildId) {
    const mapped = [];
    for (const [, ow] of overwrites) {
      // Si es @everyone, usar el ID del servidor destino
      if (ow.id === originGuildId) {
        mapped.push({
          id: destGuildId,
          allow: ow.allow.bitfield,
          deny: ow.deny.bitfield,
          type: 0, // role
        });
        continue;
      }
      // Buscar el rol por nombre en el destino
      const originRole = originGuild.roles.cache.get(ow.id);
      if (!originRole) continue;
      const destRole = roleNameMap.get(originRole.name);
      if (destRole) {
        mapped.push({
          id: destRole.id,
          allow: ow.allow.bitfield,
          deny: ow.deny.bitfield,
          type: 0,
        });
      }
      // Si no se encuentra el rol en destino, se omite ese overwrite
    }
    return mapped;
  }

  // ----- 4. Copiar categorías y canales -----
  const categories = originGuild.channels.cache
    .filter((c) => c.type === ChannelType.GuildCategory)
    .sort((a, b) => a.position - b.position);

  for (const [, cat] of categories) {
    try {
      const newCat = await destGuild.channels.create({
        name: cat.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: mapOverwrites(
          cat.permissionOverwrites.cache,
          originGuild.id,
          destGuild.id
        ),
      });
      await sleep(1000);

      const childChannels = originGuild.channels.cache
        .filter(
          (c) =>
            c.parentId === cat.id &&
            (c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice)
        )
        .sort((a, b) => a.position - b.position);

      for (const [, ch] of childChannels) {
        try {
          const channelType =
            ch.type === ChannelType.GuildVoice
              ? ChannelType.GuildVoice
              : ChannelType.GuildText;

          await destGuild.channels.create({
            name: ch.name,
            type: channelType,
            parent: newCat.id,
            permissionOverwrites: mapOverwrites(
              ch.permissionOverwrites.cache,
              originGuild.id,
              destGuild.id
            ),
            ...(channelType === ChannelType.GuildText && ch.topic ? { topic: ch.topic } : {}),
            ...(channelType === ChannelType.GuildVoice
              ? {
                  bitrate: Math.min(ch.bitrate, destGuild.maximumBitrate),
                  userLimit: ch.userLimit,
                }
              : {}),
          });
          await sleep(1000);
        } catch (e) {
          steps.push(`⚠️ Error con canal "${ch.name}": ${e.message}`);
        }
      }
    } catch (e) {
      steps.push(`⚠️ Error con categoría "${cat.name}": ${e.message}`);
    }
  }

  // ----- 5. Canales sin categoría -----
  const noCatChannels = originGuild.channels.cache
    .filter(
      (c) =>
        !c.parentId &&
        (c.type === ChannelType.GuildText || c.type === ChannelType.GuildVoice)
    )
    .sort((a, b) => a.position - b.position);

  for (const [, ch] of noCatChannels) {
    try {
      const channelType =
        ch.type === ChannelType.GuildVoice
          ? ChannelType.GuildVoice
          : ChannelType.GuildText;
      await destGuild.channels.create({
        name: ch.name,
        type: channelType,
        permissionOverwrites: mapOverwrites(
          ch.permissionOverwrites.cache,
          originGuild.id,
          destGuild.id
        ),
        ...(channelType === ChannelType.GuildText && ch.topic ? { topic: ch.topic } : {}),
        ...(channelType === ChannelType.GuildVoice
          ? {
              bitrate: Math.min(ch.bitrate, destGuild.maximumBitrate),
              userLimit: ch.userLimit,
            }
          : {}),
      });
      await sleep(1000);
    } catch (e) {
      steps.push(`⚠️ Error con canal "${ch.name}": ${e.message}`);
    }
  }

  userClient.destroy();

  const finalReport =
    `**Clonación completada**\n` +
    steps.join("\n") +
    `\n\n⚠️ Los permisos de canales usan los roles copiados por nombre. Si había roles con nombres duplicados, puede haber conflictos.`;

  return finalReport;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Iniciar el bot
// ---------------------------------------------------------------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error("❌ Falta la variable de entorno BOT_TOKEN");
  process.exit(1);
}

bot.login(BOT_TOKEN);
