const ID = "shared-token-turns";
const busy = new Set();

function groups(combat) {
  return combat.getFlag(ID, "groups") ?? [];
}

// The first available, undefeated member represents the group.
// Keep every Combatant document so individual initiatives and token ownership survive.
export function layout(sorted, definitions) {
  const byId = new Map(sorted.map(c => [c.id, c]));
  const representative = new Map();
  for (const ids of definitions) {
    const members = ids.map(id => byId.get(id)).filter(Boolean);
    const leader = members.find(c => !c.isDefeated && !c.hidden)
      ?? members.find(c => !c.isDefeated) ?? members[0];
    for (const c of members) representative.set(c.id, leader);
  }
  return { turns: sorted.filter(c => !representative.has(c.id) || representative.get(c.id) === c), representative };
}

function companions(combat, c) {
  const ids = c && groups(combat).find(ids => ids.includes(c.id));
  return (ids ?? []).filter(id => id !== c.id).map(id => combat.combatants.get(id)).filter(Boolean);
}

function installCombat() {
  const Base = CONFIG.Combat.documentClass;
  CONFIG.Combat.documentClass = class SharedTurnCombat extends Base {
    setupTurns() {
      const sorted = super.setupTurns();
      if (!groups(this).length) return sorted;
      this.turns = layout(sorted, groups(this)).turns;
      if (this.turn !== null && this.turn >= this.turns.length) this.turn = Math.max(0, this.turns.length - 1);
      this.current = this._getCurrentState(this.combatant);
      return this.turns;
    }

    async _onStartTurn(c, ...args) {
      await super._onStartTurn(c, ...args);
      for (const member of companions(this, c)) {
        if (member.actor && !member.isDefeated) await member.recoverCombatUses(["turn", "turnStart"]);
      }
    }

    async _onEndTurn(c, ...args) {
      await super._onEndTurn(c, ...args);
      for (const member of companions(this, c)) {
        if (member.actor && !member.isDefeated) await member.recoverCombatUses(["turnEnd"]);
      }
    }

    async _clearMovementHistoryOnStartTurn(c, ...args) {
      await super._clearMovementHistoryOnStartTurn(c, ...args);
      for (const member of companions(this, c)) {
        if (member.token && !member.isDefeated) await super._clearMovementHistoryOnStartTurn(member, ...args);
      }
    }
  };
}

async function edit(combat, dissolve) {
  if (!game.user.isGM || !combat || busy.has(combat.id)) return;
  const tokens = canvas.tokens?.controlled ?? [];
  const matches = tokens.map(t => combat.combatants.filter(c => c.tokenId === t.id && (c.sceneId ?? c.token?.parent?.id) === canvas.scene.id));
  if (tokens.length < (dissolve ? 1 : 2) || matches.some(m => m.length !== 1)) {
    return ui.notifications.warn(dissolve ? "請選取已加入這場遭遇的組員。" : "請選取至少兩個已加入這場遭遇的 Token。每個 Token 須各有一筆參戰紀錄。");
  }
  const selected = new Set(matches.map(m => m[0].id));
  const existing = groups(combat);
  const affected = existing.filter(ids => ids.some(id => selected.has(id)));
  if (dissolve && !affected.length) return ui.notifications.info("所選 Token 尚未編組。");
  if (!dissolve && affected.length) return ui.notifications.warn("選取範圍內已有共用回合的成員，請先解除原有編組。");
  const next = existing.filter(ids => !affected.includes(ids));
  const sorted = combat.combatants.contents.slice().sort((a, b) => combat._sortCombatants(a, b));
  if (!dissolve) next.push(sorted.filter(c => selected.has(c.id)).map(c => c.id));
  const changes = { [`flags.${ID}.groups`]: next };
  const active = combat.combatant;
  if (combat.started && active) {
    const plan = layout(sorted, next);
    changes.turn = plan.turns.indexOf(plan.representative.get(active.id) ?? active);
  }
  busy.add(combat.id);
  try {
    await combat.update(changes);
    ui.notifications.info(dissolve ? "已解除共用回合。" : "已建立共用回合。");
  } catch (error) {
    console.error(ID, error);
    ui.notifications.error("編組更新失敗，請查看主控台。");
  } finally {
    busy.delete(combat.id);
  }
}

function render(app, html) {
  const combat = app.viewed;
  if (!combat) return;
  html.querySelectorAll("[data-shared-turn-ui]").forEach(el => el.remove());
  const list = html.querySelector(".combat-tracker, .directory-list");
  if (!list) return;
  for (const c of combat.turns) {
    const others = companions(combat, c).filter(m => m.visible);
    const row = list.querySelector(`[data-combatant-id="${c.id}"] .token-name`);
    if (!others.length || !row) continue;
    const label = document.createElement("small");
    label.dataset.sharedTurnUi = "";
    label.textContent = "同回合：" + others.map(m => m.name).join("、");
    row.append(label);
  }
  if (!game.user.isGM) return;
  const bar = document.createElement("div");
  bar.className = "flexrow";
  bar.dataset.sharedTurnUi = "";
  for (const [title, dissolve] of [["共用回合", false], ["解除編組", true]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = title;
    button.addEventListener("click", () => edit(combat, dissolve));
    bar.append(button);
  }
  list.before(bar);
}

Hooks.once("init", () => {
  if (game.release.generation !== 13 || game.system.id !== "dnd5e" || !game.system.version.startsWith("5.")) return;
  installCombat();
  Hooks.on("updateCombat", (combat, delta) => {
    if (delta.flags?.[ID]) {
      combat.setupTurns();
      ui.combat.render();
    }
  });
  Hooks.on("renderCombatTracker", render);
});
