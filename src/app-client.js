
    function terrainBoostsMove(moveType, terrain) {
      if (!terrain || terrain === "neutral") return false;
      const boosted = TERRAIN_MOVE_BONUS[terrain];
      return Array.isArray(boosted) && boosted.indexOf(moveType) !== -1;
    }

    function typeMultiplierFor(moveType, defenderTypes) {
      return (defenderTypes || []).reduce(
        (multiplier, defenderType) => multiplier * (TYPE_CHART[moveType]?.[defenderType] ?? 1),
        1
      );
    }

    function stagedStatValue(base, stage) {
      const clamped = Math.max(-4, Math.min(4, Number(stage) || 0));
      if (clamped >= 0) return base * (1 + clamped * 0.25);
      return base / (1 + Math.abs(clamped) * 0.25);
    }

    // Mirrors game.js moveManaCost — keep the two formulas in sync.
    function moveManaCost(move) {
      if (!move || move.id === "struggle") return 0;
      if (move.category === "status") return 3;
      const base = Math.round((Number(move.power) || 0) / 10);
      let cost = Math.max(2, Math.min(6, base));
      if (move.effect && move.effect.kind === "multihit") cost += 1;
      return cost;
    }

    // Mirrors the server damage formula (game.js estimateDamage) at mid
    // variance so move buttons can show an honest "~N dmg" against the
    // current opponent, including stat stages, STAB, and fatigue.
    function estimateMoveDamage(battle, attacker, defender, move) {
      if (!move || move.category === "status" || !move.power) return null;
      const attackKey = move.category === "physical" ? "strike" : "sense";
      const atk = stagedStatValue(attacker.stats[attackKey], attacker.statStages && attacker.statStages[attackKey]);
      const guard = stagedStatValue(defender.stats.guard, defender.statStages && defender.statStages.guard);
      const def = move.category === "physical"
        ? guard
        : (guard + stagedStatValue(defender.stats.sense, defender.statStages && defender.statStages.sense)) / 2;
      const stab = (attacker.types || []).includes(move.type) ? 1.15 : 1;
      const typeMult = typeMultiplierFor(move.type, defender.types || []);
      const terrain = terrainBoostsMove(move.type, battle.terrain) ? 1.15 : 1;
      const bond = 1 + Math.min(0.08, (attacker.bondLevel || 0) * 0.002);
      const fatigue = 1 + Math.max(0, (battle.turn || 0) - 20) * 0.06;
      const base = move.power * (atk / Math.max(1, def)) * stab * typeMult * terrain * bond * 0.6 * 0.975 * fatigue;
      return Math.max(1, Math.floor(base));
    }

    function describeMoveEffect(move) {
      const parts = [];
      if ((move.priority || 0) > 0) parts.push("strikes first");
      const effect = move.effect;
      if (!effect) return parts;
      const statLabel = { vigor: "Vigor", strike: "Strike", guard: "Guard", tempo: "Tempo", sense: "Sense" };

      if (effect.kind === "buff") {
        parts.push("+" + (effect.amount || 1) + " " + (statLabel[effect.stat] || effect.stat) + " self");
      } else if (effect.kind === "debuff") {
        parts.push("-" + (effect.amount || 1) + " " + (statLabel[effect.stat] || effect.stat) + " foe");
      } else if (effect.kind === "heal") {
        parts.push("heal " + (effect.amountPct || 0) + "% HP");
      } else if (effect.kind === "status") {
        const verb = { stunned: "stun", marked: "mark", poisoned: "poison", shielded: "shield" }[effect.status] || effect.status;
        const target = effect.status === "shielded" ? "self" : "foe";
        const chance = effect.chance && effect.chance < 100 ? effect.chance + "% " : "";
        parts.push(chance + verb + " " + target);
      } else if (effect.kind === "drain") {
        parts.push("drain " + (effect.pct || 30) + "% of dmg");
      } else if (effect.kind === "recoil") {
        parts.push((effect.pct || 25) + "% recoil");
      } else if (effect.kind === "multihit") {
        parts.push("hits " + (effect.min || 2) + "-" + (effect.max || 3) + "x");
      }
      return parts;
    }

    const TREE_LOADING_MESSAGES = [
      "Coaxing DNA to tell its evolutionary secrets...",
      "Unraveling the tree of life, one branch at a time...",
      "Consulting with Darwin about your taxonomy...",
      "Politely asking species to line up in order...",
      "Counting rings on the tree of life...",
      "Persuading taxonomists to agree on classifications...",
      "Gathering specimens from the digital wild...",
      "Dusting off Linnaeus' old notebooks...",
      "Herding taxonomic cats into hierarchical boxes...",
      "Calculating phylogenetic distances while sipping tea...",
      "Untangling evolutionary spaghetti...",
      "Converting genetic code to pretty pictures...",
      "Teaching old species new tricks...",
      "Searching for the missing links...",
      "Translating from Latin to Markdown...",
      "Convincing kingdoms, phyla, and classes to cooperate..."
    ];
    const TREE_CLIENT_CACHE_TTL_MS = 2 * 60 * 1000;

    const state = {
      userId: localStorage.getItem("inatBattler:userId") || "",
      inatLogin: localStorage.getItem("inatBattler:inatLogin") || "",
      activeView: "home",
      taxa: [],
      rosterSummary: null,
      rosterSearch: "",
      rosterSort: "default",
      rosterStatus: "all",
      rosterIconic: "",
      rosterPage: 1,
      rosterTotal: 0,
      rosterIconicCounts: [],
      rosterZoom: Number(localStorage.getItem("inatBattler:rosterZoom")) || 190,
      rosterMode: localStorage.getItem("inatBattler:rosterMode") === "sprites" ? "sprites" : "cards",
      spriteTree: null,
      spriteTreeLoading: false,
      spriteTreeError: "",
      spriteTreeMessage: TREE_LOADING_MESSAGES[0],
      spriteTreeMessageTimer: null,
      spriteTreeRequestId: 0,
      spriteTreeCache: new Map(),
      treeSearch: "",
      treeZoom: Number(localStorage.getItem("inatBattler:treeZoom")) || 58,
      recentSprites: null,
      landingSpritesLoaded: false,
      showImportSummary: false,
      recentSearch: "",
      recentSort: "newest",
      recentGroup: "all",
      recentZoom: Number(localStorage.getItem("inatBattler:recentZoom")) || 150,
      expandedTreeNodes: new Set(),
      treePath: [],
      selectedTaxa: new Set(),
      flippedTaxa: new Set(),
      battle: null,
      battleAnimation: "anim-idle",
      battleBusy: false,
      battlePhase: "idle",
      soundOn: localStorage.getItem("inatBattler:sound") !== "off",
      backdropCache: null,
      lastResultBattle: null,
      polling: null,
      pollDelayMs: 0,
      me: null,
      presence: {
        started: false,
        status: "idle",
        ws: null,
        reconnectTimer: null,
        decayTimer: null,
        renderTimer: null,
        settleAt: 0,
        backfillStarted: false,
        buddies: new Map()
      },
      challenges: [],
      challengeInfo: null,
      inatLinkPending: null,
      inatChangeOpen: false,
      // Read-only "view another existing player's roster" mode. When viewUserId
      // is set, the roster grid loads that user instead of state.userId (which
      // always stays the signed-in owner) and all editing is suppressed.
      viewUserId: null,
      viewLabel: "",
      mySprites: [],
      training: null,
      trainingFilter: "",
      trainingSelected: null,
      trainingBusy: false,
      bskyBusy: false,
      bskyAction: "",
      bskyMessage: "",
      bskyMessageKind: "info"
    };

    const els = {
      form: document.getElementById("loginForm"),
      input: document.getElementById("inatLogin"),
      importButton: document.getElementById("importButton"),
      publicLanding: document.getElementById("publicLanding"),
      landingAuth: document.getElementById("landingAuth"),
      landingGallery: document.getElementById("landingGallery"),
      landingSprites: document.getElementById("landingSprites"),
      appLayout: document.getElementById("appLayout"),
      manualSpriteForm: document.getElementById("manualSpriteForm"),
      manualTaxonId: document.getElementById("manualTaxonId"),
      manualSpriteFile: document.getElementById("manualSpriteFile"),
      manualUploadButton: document.getElementById("manualUploadButton"),
      manualUploadState: document.getElementById("manualUploadState"),
      manualUploadResult: document.getElementById("manualUploadResult"),
      teamCount: document.getElementById("teamCount"),
      clearTeamButton: document.getElementById("clearTeamButton"),
      startBattleButton: document.getElementById("startBattleButton"),
      npcDifficultySelect: document.getElementById("npcDifficultySelect"),
      statusLine: document.getElementById("statusLine"),
      accountLabel: document.getElementById("accountLabel"),
      taxaCount: document.getElementById("taxaCount"),
      spriteCount: document.getElementById("spriteCount"),
      queuedCount: document.getElementById("queuedCount"),
      bondCount: document.getElementById("bondCount"),
      refreshLabel: document.getElementById("refreshLabel"),
      homeTabButton: document.getElementById("homeTabButton"),
      homeView: document.getElementById("homeView"),
      homeDashboard: document.getElementById("homeDashboard"),
      rosterTabButton: document.getElementById("rosterTabButton"),
      treeTabButton: document.getElementById("treeTabButton"),
      recentTabButton: document.getElementById("recentTabButton"),
      rosterView: document.getElementById("rosterView"),
      treeView: document.getElementById("treeView"),
      recentView: document.getElementById("recentView"),
      treeSearchInput: document.getElementById("treeSearchInput"),
      treeRefreshButton: document.getElementById("treeRefreshButton"),
      treeRefreshLabel: document.getElementById("treeRefreshLabel"),
      treeZoomInput: document.getElementById("treeZoomInput"),
      spriteTreePanel: document.getElementById("spriteTreePanel"),
      recentSearchInput: document.getElementById("recentSearchInput"),
      recentRefreshButton: document.getElementById("recentRefreshButton"),
      recentRefreshLabel: document.getElementById("recentRefreshLabel"),
      recentSortSelect: document.getElementById("recentSortSelect"),
      recentGroupFilter: document.getElementById("recentGroupFilter"),
      recentZoomInput: document.getElementById("recentZoomInput"),
      recentSpritesPanel: document.getElementById("recentSpritesPanel"),
      rosterGrid: document.getElementById("rosterGrid"),
      emptyState: document.getElementById("emptyState"),
      rosterSearchInput: document.getElementById("rosterSearchInput"),
      rosterSortSelect: document.getElementById("rosterSortSelect"),
      rosterStatusFilter: document.getElementById("rosterStatusFilter"),
      rosterZoomInput: document.getElementById("rosterZoomInput"),
      rosterModeButton: document.getElementById("rosterModeButton"),
      rosterTypeChips: document.getElementById("rosterTypeChips"),
      rosterPagination: document.getElementById("rosterPagination"),
      rosterLookupInput: document.getElementById("rosterLookupInput"),
      rosterLookupButton: document.getElementById("rosterLookupButton"),
      rosterViewBanner: document.getElementById("rosterViewBanner"),
      settingsInatAccount: document.getElementById("settingsInatAccount"),
      apiKeyLabelInput: document.getElementById("apiKeyLabelInput"),
      apiKeyCreateButton: document.getElementById("apiKeyCreateButton"),
      apiKeyReveal: document.getElementById("apiKeyReveal"),
      apiKeyList: document.getElementById("apiKeyList"),
      battlePanel: document.getElementById("battlePanel"),
      battleTabButton: document.getElementById("battleTabButton"),
      battleView: document.getElementById("battleView"),
      battleEmptyState: document.getElementById("battleEmptyState"),
      leaderboardTabButton: document.getElementById("leaderboardTabButton"),
      leaderboardView: document.getElementById("leaderboardView"),
      leaderboardPanel: document.getElementById("leaderboardPanel"),
      leaderboardMetaLabel: document.getElementById("leaderboardMetaLabel"),
      leaderboardModeToggle: document.getElementById("leaderboardModeToggle"),
      leaderboardRefreshButton: document.getElementById("leaderboardRefreshButton"),
      buddiesTabButton: document.getElementById("buddiesTabButton"),
      buddiesView: document.getElementById("buddiesView"),
      buddiesPanel: document.getElementById("buddiesPanel"),
      buddiesMetaLabel: document.getElementById("buddiesMetaLabel"),
      buddiesRefreshButton: document.getElementById("buddiesRefreshButton"),
      mapTabButton: document.getElementById("mapTabButton"),
      mapView: document.getElementById("mapView"),
      mapCanvas: document.getElementById("mapCanvas"),
      mapLegend: document.getElementById("mapLegend"),
      mapStatusLabel: document.getElementById("mapStatusLabel"),
      mapSyncButton: document.getElementById("mapSyncButton"),
      mapModeToggle: document.getElementById("mapModeToggle"),
      tilePanel: document.getElementById("tilePanel"),
      mobileNav: document.getElementById("mobileNav"),
      mobileMoreButton: document.getElementById("mobileMoreButton"),
      mobileSheet: document.getElementById("mobileSheet"),
      trainingTabButton: document.getElementById("trainingTabButton"),
      trainingView: document.getElementById("trainingView"),
      trainingTotalsLabel: document.getElementById("trainingTotalsLabel"),
      trainingFilterInput: document.getElementById("trainingFilterInput"),
      trainingSyncButton: document.getElementById("trainingSyncButton"),
      trainingEmptyState: document.getElementById("trainingEmptyState"),
      trainingMasteries: document.getElementById("trainingMasteries"),
      trainingMasteriesSummary: document.getElementById("trainingMasteriesSummary"),
      trainingMasteriesBody: document.getElementById("trainingMasteriesBody"),
      trainingSplit: document.getElementById("trainingSplit"),
      trainingList: document.getElementById("trainingList"),
      trainingDetail: document.getElementById("trainingDetail"),
      settingsTabButton: document.getElementById("settingsTabButton"),
      settingsView: document.getElementById("settingsView"),
      settingsHighlightOptIn: document.getElementById("settingsHighlightOptIn"),
      settingsReimportButton: document.getElementById("settingsReimportButton"),
      settingsSignOutButton: document.getElementById("settingsSignOutButton"),
      settingsSoundToggle: document.getElementById("settingsSoundToggle"),
      themeToggle: document.getElementById("themeToggle"),
      settingsDeleteButton: document.getElementById("settingsDeleteButton"),
      settingsDeletePanel: document.getElementById("settingsDeletePanel"),
      deleteSharedSpritesCheck: document.getElementById("deleteSharedSpritesCheck"),
      settingsDeleteCancel: document.getElementById("settingsDeleteCancel"),
      settingsDeleteConfirm: document.getElementById("settingsDeleteConfirm"),
      bskyStateLabel: document.getElementById("bskyStateLabel"),
      bskyBody: document.getElementById("bskyBody")
    };

    els.input.value = state.inatLogin;
    renderLanding();

    els.form.addEventListener("submit", async (event) => {
      event.preventDefault();
      // Always imports your OWN linked profile; the typed field is ignored (the
      // server derives the login from your verified session either way).
      await importRoster();
    });

    els.homeTabButton.addEventListener("click", () => switchView("home"));
    els.rosterTabButton.addEventListener("click", () => switchView("roster"));
    els.battleTabButton.addEventListener("click", () => switchView("battle"));
    els.leaderboardTabButton.addEventListener("click", () => switchView("leaderboard"));
    els.buddiesTabButton.addEventListener("click", () => switchView("buddies"));
    els.mapTabButton.addEventListener("click", () => switchView("map"));
    els.mapSyncButton.addEventListener("click", syncTerritory);
    els.mapModeToggle.addEventListener("click", (event) => {
      const button = event.target.closest("[data-map-mode]");
      if (button) setMapMode(button.getAttribute("data-map-mode"));
    });
    els.tilePanel.addEventListener("click", (event) => {
      if (event.target.closest("[data-tile-close]")) { closeTilePanel(); return; }
      const claim = event.target.closest("[data-tile-claim]");
      if (claim) { claimTile(claim.getAttribute("data-tile-claim")); return; }
      const garrison = event.target.closest("[data-tile-garrison]");
      if (garrison) { garrisonTile(garrison.getAttribute("data-tile-garrison")); return; }
      const contest = event.target.closest("[data-tile-contest]");
      if (contest) { contestTile(contest.getAttribute("data-tile-contest")); return; }
    });
    els.trainingTabButton.addEventListener("click", () => switchView("training"));
    els.buddiesRefreshButton.addEventListener("click", () => startPresence(true));
    els.buddiesPanel.addEventListener("click", onBuddiesPanelClick);

    function setMobileSheet(open) {
      els.mobileSheet.hidden = !open;
    }

    els.mobileMoreButton.addEventListener("click", () => {
      playSfx("click");
      setMobileSheet(els.mobileSheet.hidden);
    });

    els.mobileNav.addEventListener("click", (event) => {
      const button = event.target.closest("[data-mobile-nav]");
      if (!button) return;
      switchView(button.getAttribute("data-mobile-nav"));
    });

    els.mobileSheet.addEventListener("click", (event) => {
      if (event.target.closest("[data-mobile-sheet-close]")) {
        setMobileSheet(false);
        return;
      }
      const button = event.target.closest("[data-mobile-nav]");
      if (!button) return;
      setMobileSheet(false);
      switchView(button.getAttribute("data-mobile-nav"));
    });
    els.treeTabButton.addEventListener("click", () => switchView("tree"));
    els.recentTabButton.addEventListener("click", () => switchView("recent"));
    els.settingsTabButton.addEventListener("click", () => switchView("settings"));
    els.settingsReimportButton.addEventListener("click", () => importRoster());
    els.settingsSignOutButton.addEventListener("click", () => bskyLogout());
    els.themeToggle.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-theme-pref]");
      if (btn) setThemePreference(btn.getAttribute("data-theme-pref"));
    });
    els.settingsHighlightOptIn.addEventListener("change", async () => {
      const enabled = els.settingsHighlightOptIn.checked;
      els.settingsHighlightOptIn.disabled = true;
      try {
        const res = await apiFetch("/api/settings/highlight-opt-in", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled })
        });
        if (state.me) state.me.allowHighlightBot = res.allowHighlightBot;
        setStatus(res.allowHighlightBot ? "The bot may now feature your battles." : "Highlight bot disabled for your battles.");
      } catch (error) {
        els.settingsHighlightOptIn.checked = !enabled; // revert
        setStatus(error.message || "Could not update setting");
      } finally {
        els.settingsHighlightOptIn.disabled = false;
      }
    });

    const closeDeleteModal = () => {
      els.settingsDeletePanel.hidden = true;
      els.deleteSharedSpritesCheck.checked = false;
    };
    els.settingsDeleteButton.addEventListener("click", () => {
      els.settingsDeletePanel.hidden = false;
    });
    els.settingsDeleteCancel.addEventListener("click", closeDeleteModal);
    // Dismiss on backdrop click or Escape (but not while a delete is in flight).
    els.settingsDeletePanel.addEventListener("click", (event) => {
      if (event.target === els.settingsDeletePanel && !els.settingsDeleteConfirm.disabled) closeDeleteModal();
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !els.settingsDeletePanel.hidden && !els.settingsDeleteConfirm.disabled) {
        closeDeleteModal();
      }
    });
    els.settingsDeleteConfirm.addEventListener("click", async () => {
      els.settingsDeleteConfirm.disabled = true;
      els.settingsDeleteConfirm.textContent = "Deleting…";
      try {
        await apiFetch("/api/account/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ deleteSharedSprites: els.deleteSharedSpritesCheck.checked })
        });
        // Account + session are gone; reload to the public landing.
        window.location.href = "/";
      } catch (error) {
        els.settingsDeleteConfirm.disabled = false;
        els.settingsDeleteConfirm.textContent = "Permanently delete";
        setStatus(error.message || "Could not delete account");
      }
    });
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
        if ((localStorage.getItem("inatBattler:theme") || "system") === "system") applyTheme();
      });
    }
    applyTheme();

    function setThemePreference(pref) {
      if (!["light", "dark", "system"].includes(pref)) pref = "system";
      localStorage.setItem("inatBattler:theme", pref);
      applyTheme();
    }

    function applyTheme() {
      const pref = localStorage.getItem("inatBattler:theme") || "system";
      const dark = pref === "dark" || (pref === "system" && window.matchMedia
        && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
      const meta = document.querySelector('meta[name="theme-color"]');
      if (meta) meta.setAttribute("content", dark ? "#11161a" : "#047c78");
      if (els.themeToggle) {
        for (const btn of els.themeToggle.querySelectorAll("[data-theme-pref]")) {
          btn.classList.toggle("active", btn.getAttribute("data-theme-pref") === pref);
        }
      }
    }
    els.settingsSoundToggle.addEventListener("change", () => {
      state.soundOn = els.settingsSoundToggle.checked;
      localStorage.setItem("inatBattler:sound", state.soundOn ? "on" : "off");
      if (state.battle) renderBattle();
    });

    els.trainingSyncButton.addEventListener("click", syncTraining);

    els.trainingFilterInput.addEventListener("input", debounce(() => {
      state.trainingFilter = els.trainingFilterInput.value.trim().toLowerCase();
      renderTraining();
    }, 200));

    els.trainingSplit.addEventListener("click", async (event) => {
      const selectRow = event.target.closest("[data-train-select]");
      if (selectRow) {
        state.trainingSelected = selectRow.getAttribute("data-train-select");
        renderTraining();
        return;
      }

      const addButton = event.target.closest("[data-train-add]");
      if (addButton) {
        await allocateStat(
          addButton.getAttribute("data-train-taxon"),
          addButton.getAttribute("data-train-add"),
          Number(addButton.getAttribute("data-train-amount") || 1)
        );
        return;
      }

      const respecButton = event.target.closest("[data-train-respec]");
      if (respecButton) {
        await respecSpecies(respecButton.getAttribute("data-train-respec"));
        return;
      }

      const nickButton = event.target.closest("[data-train-nick]");
      if (nickButton) {
        await saveNickname(nickButton.getAttribute("data-train-nick"));
      }
    });

    els.trainingSplit.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter" || !event.target.hasAttribute("data-train-nick-input")) return;
      event.preventDefault();
      await saveNickname(event.target.getAttribute("data-train-nick-input"));
    });

    els.treeRefreshButton.addEventListener("click", async () => {
      state.treeSearch = els.treeSearchInput.value.trim();
      await loadSpriteTree(true);
    });

    els.treeSearchInput.addEventListener("input", debounce(async () => {
      if (state.activeView !== "tree") return;
      state.treeSearch = els.treeSearchInput.value.trim();
      await loadSpriteTree(false);
    }, 250));

    els.recentRefreshButton.addEventListener("click", async () => {
      state.recentSearch = els.recentSearchInput.value.trim();
      await loadRecentSprites(true);
    });

    els.recentSearchInput.addEventListener("input", debounce(async () => {
      if (state.activeView !== "recent") return;
      state.recentSearch = els.recentSearchInput.value.trim();
      await loadRecentSprites(false);
    }, 250));

    els.manualSpriteForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      await uploadManualSprite();
    });

    els.clearTeamButton.addEventListener("click", () => {
      state.selectedTaxa.clear();
      render();
    });

    els.startBattleButton.addEventListener("click", startNpcBattle);

    // The Battle empty state is re-rendered as a dynamic arena entry point, so its
    // buttons are wired by delegation (re-rendering would drop direct listeners).
    els.battleEmptyState.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-empty-action]");
      if (!button) return;
      const action = button.getAttribute("data-empty-action");
      if (action === "pick-team") {
        state.rosterStatus = "ready";
        state.rosterPage = 1;
        if (els.rosterStatusFilter) els.rosterStatusFilter.value = "ready";
        await reloadRosterPage(true);
        await switchView("roster");
      } else if (action === "battle-npc") {
        await startNpcBattle();
      } else if (action === "demo") {
        await startDemoBattle();
      }
    });

    els.leaderboardRefreshButton.addEventListener("click", () => loadLeaderboard(true));
    els.leaderboardModeToggle.addEventListener("click", (event) => {
      const button = event.target.closest("[data-lb-mode]");
      if (button) setLeaderboardMode(button.getAttribute("data-lb-mode"));
    });

    els.leaderboardPanel.addEventListener("click", async (event) => {
      const nameLink = event.target.closest("[data-view-roster]");
      if (nameLink) {
        await enterRosterView(nameLink.getAttribute("data-view-roster"), nameLink.getAttribute("data-view-label"));
        return;
      }

      const shareButton = event.target.closest("[data-share-rank]");
      if (!shareButton || shareButton.disabled) return;

      shareButton.disabled = true;
      shareButton.textContent = "Posting…";
      try {
        const res = await apiFetch("/api/share/rank", { method: "POST" });
        shareButton.textContent = "Posted ✓";
        setStatus("Rank posted to Bluesky");
        if (res.webUrl) window.open(res.webUrl, "_blank", "noopener");
      } catch (error) {
        shareButton.disabled = false;
        shareButton.textContent = "Post my rank to Bluesky 🦋";
        setStatus(error.message);
      }
    });

    els.homeDashboard.addEventListener("click", async (event) => {
      const addButton = event.target.closest("[data-home-add-taxon]");
      if (addButton) {
        toggleTeamSelection(addButton.getAttribute("data-home-add-taxon"));
        return;
      }

      const actionButton = event.target.closest("[data-home-action]");
      if (!actionButton) return;

      const action = actionButton.getAttribute("data-home-action");
      if (action === "roster") {
        await switchView("roster");
      } else if (action === "ready-roster") {
        state.rosterStatus = "ready";
        state.rosterPage = 1;
        els.rosterStatusFilter.value = "ready";
        await reloadRosterPage(true);
        await switchView("roster");
      } else if (action === "battle") {
        await switchView("battle");
      } else if (action === "training") {
        await switchView("training");
      } else if (action === "recent") {
        await switchView("recent");
      } else if (action === "tree") {
        await switchView("tree");
      } else if (action === "start-battle") {
        await startNpcBattle();
      } else if (action === "dismiss-import") {
        state.showImportSummary = false;
        renderHome();
      }
    });

    els.spriteTreePanel.addEventListener("click", (event) => {
      const descend = event.target.closest("[data-tree-descend]");
      if (descend) {
        const key = descend.getAttribute("data-tree-descend");
        if (key) {
          state.treePath = [...state.treePath, key];
          renderSpriteTree();
        }
        return;
      }

      const crumb = event.target.closest("[data-tree-nav]");
      if (crumb) {
        const idx = Number(crumb.getAttribute("data-tree-nav"));
        if (Number.isFinite(idx)) {
          state.treePath = state.treePath.slice(0, idx + 1);
          renderSpriteTree();
        }
      }
    });

    els.battlePanel.addEventListener("click", async (event) => {
      const soundButton = event.target.closest("[data-sound-toggle]");
      if (soundButton) {
        state.soundOn = !state.soundOn;
        localStorage.setItem("inatBattler:sound", state.soundOn ? "on" : "off");
        playSfx("click");
        renderBattle();
        return;
      }

      const openSwapButton = event.target.closest("[data-open-swap]");
      if (openSwapButton) {
        state.swapOpen = true;
        playSfx("click");
        renderBattle();
        return;
      }

      const swapRow = event.target.closest("[data-swap-index]");
      if (swapRow) {
        if (state.battleBusy || state.battlePhase === "intro") return;
        state.swapOpen = false;
        await submitBattleMove(null, Number(swapRow.getAttribute("data-swap-index")));
        return;
      }

      if (event.target.closest("[data-swap-close]") || event.target.classList.contains("swap-modal")) {
        state.swapOpen = false;
        renderBattle();
        return;
      }

      const exitButton = event.target.closest("[data-battle-exit]");
      if (exitButton) {
        state.battle = null;
        state.battlePhase = "idle";
        state.swapOpen = false;
        document.body.classList.remove("battle-active");
        renderBattle();
        switchView("roster");
        return;
      }

      const leaderboardButton = event.target.closest("[data-open-leaderboard]");
      if (leaderboardButton) {
        await switchView("leaderboard");
        return;
      }

      const shareVideoButton = event.target.closest("[data-share-video]");
      if (shareVideoButton) {
        const id = shareVideoButton.getAttribute("data-share-video");
        // The /replay page renders the MP4 in-browser and posts it to the user's
        // own Bluesky (with an option to also share to the @wildmarch feed).
        window.open("/replay/" + encodeURIComponent(id) + "?share=1", "_blank", "noopener");
        return;
      }

      const shareBattleButton = event.target.closest("[data-share-battle]");
      if (shareBattleButton) {
        if (shareBattleButton.disabled || !state.battle) return;
        shareBattleButton.disabled = true;
        shareBattleButton.textContent = "Posting…";
        try {
          const res = await apiFetch("/api/share/battle", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ battleId: state.battle.battleId })
          });
          shareBattleButton.textContent = "Posted ✓";
          setStatus("Victory posted to Bluesky");
          if (res.webUrl) window.open(res.webUrl, "_blank", "noopener");
        } catch (error) {
          shareBattleButton.disabled = false;
          shareBattleButton.textContent = "Brag on Bluesky 🦋";
          setStatus(error.message);
        }
        return;
      }

      const button = event.target.closest("[data-move-id]");
      if (!button || state.battleBusy || state.battlePhase === "intro") return;
      await submitBattleMove(button.getAttribute("data-move-id"));
    });

    els.rosterGrid.addEventListener("click", async (event) => {
      // Sprite-variant preference is a write tied to the owner's account, so it
      // is disabled while viewing another player's roster.
      const spriteButton = event.target.closest("[data-sprite-shift]");
      if (spriteButton && !state.viewUserId) {
        event.stopPropagation();
        await chooseSpriteVariant(
          spriteButton.getAttribute("data-taxon-id"),
          Number(spriteButton.getAttribute("data-sprite-shift") || 0)
        );
        return;
      }

      // The corner toggle builds your team; it must not also flip the card.
      const selectButton = event.target.closest("[data-card-select]");
      if (selectButton) {
        event.stopPropagation();
        if (!selectButton.disabled) toggleTeamSelection(selectButton.getAttribute("data-taxon-id"));
        return;
      }

      const card = event.target.closest("[data-taxon-card]");
      if (!card) return;
      // Card view: a click anywhere flips between sprite and stats (both ways).
      // Sprite-grid view has no back face, so a click there picks the team.
      if (state.rosterMode === "cards") {
        toggleCardFlip(card.getAttribute("data-taxon-id"));
      } else if (!state.viewUserId) {
        toggleTeamSelection(card.getAttribute("data-taxon-id"));
      }
    });

    els.rosterGrid.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      // Let focusable controls (the select toggle, sprite arrows) handle their own
      // keys; only the card itself flips/selects.
      if (event.target.closest("[data-card-select], [data-sprite-shift]")) return;
      const card = event.target.closest("[data-taxon-card]");
      if (!card) return;
      event.preventDefault();
      // Mirror click: flip in card view, select in sprite view.
      if (state.rosterMode === "cards") {
        toggleCardFlip(card.getAttribute("data-taxon-id"));
      } else if (!state.viewUserId) {
        toggleTeamSelection(card.getAttribute("data-taxon-id"));
      }
    });

    els.rosterSearchInput.addEventListener("input", debounce(() => {
      state.rosterSearch = els.rosterSearchInput.value.trim();
      reloadRosterPage(true);
    }, 300));

    els.rosterSortSelect.addEventListener("change", () => {
      state.rosterSort = els.rosterSortSelect.value;
      reloadRosterPage(true);
    });

    els.rosterStatusFilter.addEventListener("change", () => {
      state.rosterStatus = els.rosterStatusFilter.value;
      reloadRosterPage(true);
    });

    els.rosterPagination.addEventListener("click", (event) => {
      const button = event.target.closest("[data-roster-page]");
      if (!button || button.disabled) return;
      const direction = button.getAttribute("data-roster-page");
      const pageCount = Math.max(1, Math.ceil(state.rosterTotal / ROSTER_PAGE_SIZE));
      const nextPage = direction === "prev" ? state.rosterPage - 1 : state.rosterPage + 1;
      if (nextPage < 1 || nextPage > pageCount) return;
      state.rosterPage = nextPage;
      els.rosterView.scrollIntoView({ behavior: "smooth", block: "start" });
      reloadRosterPage(false);
    });

    els.rosterZoomInput.addEventListener("input", () => {
      state.rosterZoom = Number(els.rosterZoomInput.value) || 190;
      localStorage.setItem("inatBattler:rosterZoom", String(state.rosterZoom));
      els.rosterGrid.style.setProperty("--card-min", state.rosterZoom + "px");
    });

    els.rosterModeButton.addEventListener("click", () => {
      state.rosterMode = state.rosterMode === "sprites" ? "cards" : "sprites";
      localStorage.setItem("inatBattler:rosterMode", state.rosterMode);
      render();
    });

    els.rosterLookupButton.addEventListener("click", lookupRosterFromInput);
    els.rosterLookupInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        lookupRosterFromInput();
      }
    });
    els.rosterViewBanner.addEventListener("click", (event) => {
      if (event.target.closest("[data-roster-view-exit]")) exitRosterView();
    });

    els.rosterTypeChips.addEventListener("click", (event) => {
      const chip = event.target.closest("[data-type-chip]");
      if (!chip) return;
      const type = chip.getAttribute("data-type-chip");
      state.rosterIconic = state.rosterIconic === type ? "" : type;
      reloadRosterPage(true);
    });

    els.treeZoomInput.addEventListener("input", () => {
      state.treeZoom = Number(els.treeZoomInput.value) || 58;
      localStorage.setItem("inatBattler:treeZoom", String(state.treeZoom));
      els.spriteTreePanel.style.setProperty("--leaf-size", state.treeZoom + "px");
    });

    els.recentSortSelect.addEventListener("change", () => {
      state.recentSort = els.recentSortSelect.value;
      renderRecentSprites();
    });

    els.recentGroupFilter.addEventListener("change", () => {
      state.recentGroup = els.recentGroupFilter.value;
      renderRecentSprites();
    });

    els.recentZoomInput.addEventListener("input", () => {
      state.recentZoom = Number(els.recentZoomInput.value) || 150;
      localStorage.setItem("inatBattler:recentZoom", String(state.recentZoom));
      els.recentSpritesPanel.style.setProperty("--tile-min", state.recentZoom + "px");
    });

    els.npcDifficultySelect.value = localStorage.getItem("inatBattler:npcDifficulty") || "normal";
    els.npcDifficultySelect.addEventListener("change", () => {
      localStorage.setItem("inatBattler:npcDifficulty", els.npcDifficultySelect.value);
    });

    els.rosterZoomInput.value = String(state.rosterZoom);
    els.rosterGrid.style.setProperty("--card-min", state.rosterZoom + "px");
    els.treeZoomInput.value = String(state.treeZoom);
    els.spriteTreePanel.style.setProperty("--leaf-size", state.treeZoom + "px");
    els.recentZoomInput.value = String(state.recentZoom);
    els.recentSpritesPanel.style.setProperty("--tile-min", state.recentZoom + "px");

    function handleBskyContainerClick(event) {
      if (event.target.closest("[data-go-settings]")) {
        switchView("settings");
        return;
      }

      const pick = event.target.closest("[data-typeahead-pick]");
      if (pick) {
        const input = document.getElementById(pick.getAttribute("data-input-id"));
        if (input) {
          input.value = pick.getAttribute("data-typeahead-pick");
          input.focus();
        }
        closeTypeaheadLists();
        return;
      }

      const button = event.target.closest("[data-bsky-action]");
      if (!button) return;
      const action = button.getAttribute("data-bsky-action");

      // Instant UI toggles for the iNaturalist swap form — no network, no busy state.
      if (action === "inat-change") {
        state.inatChangeOpen = true;
        renderBsky();
        document.getElementById("inatLinkInput")?.focus();
        return;
      }
      if (action === "inat-change-cancel") {
        state.inatChangeOpen = false;
        renderBsky();
        return;
      }

      button.disabled = true;
      button.textContent = bskyBusyButtonText(action);
      handleBskyAction(action, button.getAttribute("data-challenge-id"));
    }

    function handleBskyContainerInput(event) {
      if (event.target.getAttribute && event.target.getAttribute("data-bsky-typeahead")) {
        handleTypeaheadInput(event.target);
      }
    }

    function handleBskyContainerKeydown(event) {
      if (event.target.tagName !== "INPUT") return;

      if (event.key === "Escape") {
        closeTypeaheadLists();
        return;
      }
      if (event.key !== "Enter") return;
      event.preventDefault();
      closeTypeaheadLists();
      const action = event.target.getAttribute("data-bsky-enter");
      if (action) handleBskyAction(action, null);
    }

    els.bskyBody.addEventListener("click", handleBskyContainerClick);
    els.bskyBody.addEventListener("input", handleBskyContainerInput);
    els.bskyBody.addEventListener("keydown", handleBskyContainerKeydown);
    els.landingAuth.addEventListener("click", handleBskyContainerClick);
    els.landingAuth.addEventListener("input", handleBskyContainerInput);
    els.landingAuth.addEventListener("keydown", handleBskyContainerKeydown);
    els.homeDashboard.addEventListener("click", handleBskyContainerClick);
    els.homeDashboard.addEventListener("input", handleBskyContainerInput);
    els.homeDashboard.addEventListener("keydown", handleBskyContainerKeydown);
    els.settingsInatAccount.addEventListener("click", handleBskyContainerClick);
    els.settingsInatAccount.addEventListener("input", handleBskyContainerInput);
    els.settingsInatAccount.addEventListener("keydown", handleBskyContainerKeydown);

    els.apiKeyCreateButton.addEventListener("click", createApiKeyFromInput);
    els.apiKeyList.addEventListener("click", (event) => {
      const button = event.target.closest("[data-revoke-key]");
      if (button) revokeApiKeyById(button.getAttribute("data-revoke-key"));
    });
    if (els.apiKeyReveal) {
      els.apiKeyReveal.addEventListener("click", (event) => {
        const button = event.target.closest("#apiKeyCopyButton");
        if (!button) return;
        const token = els.apiKeyReveal.querySelector(".api-key-token");
        if (token) copyWithFeedback(token.textContent, button);
      });
    }

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".typeahead")) closeTypeaheadLists();
    });

    if (state.userId) {
      loadRoster();
    }

    initBlueskySession();

    // iNaturalist v2 species_counts fields the roster/training ingest needs.
    // Mirrors the server INAT_SPECIES_COUNT_FIELDS.
    var INAT_SPECIES_COUNT_FIELDS_CLIENT = "count,taxon.id,taxon.name,taxon.preferred_common_name,taxon.english_common_name,taxon.rank,taxon.iconic_taxon_name,taxon.ancestry,taxon.parent_id,taxon.default_photo.medium_url,taxon.default_photo.square_url,taxon.default_photo.url";

    // Fetch a user's research-grade species counts in their OWN browser (iNat v2
    // sends CORS headers for GET), so the iNat rate limit lands on each user's IP
    // instead of the Worker's shared egress. MAX_PAGES mirrors the server
    // MAX_IMPORT_PAGES (20 in prod) — up to ~10k species; breaks early for most.
    async function inatBrowserFetchSpeciesCounts(login, onProgress) {
      const MAX_PAGES = 20;
      const rows = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        if (onProgress) onProgress(page);
        const params = new URLSearchParams({
          user_login: login,
          quality_grade: "research",
          per_page: "500",
          page: String(page),
          fields: INAT_SPECIES_COUNT_FIELDS_CLIENT,
          ttl: "21600"
        });
        const res = await fetch("https://api.inaturalist.org/v2/observations/species_counts?" + params.toString());
        if (!res.ok) throw new Error("iNaturalist returned " + res.status);
        const data = await res.json();
        const pageRows = (data && Array.isArray(data.results)) ? data.results : [];
        for (let i = 0; i < pageRows.length; i += 1) rows.push(pageRows[i]);
        if (pageRows.length < 500) break;
        await new Promise(function (resolve) { setTimeout(resolve, 700); });
      }
      return rows;
    }

    // Import is locked to the signed-in user's OWN linked iNaturalist account.
    async function importRoster() {
      const login = (state.me && state.me.inatLogin) || state.inatLogin;
      if (!login) {
        setStatus("Link your iNaturalist account first.");
        return;
      }
      setBusy(true, "Importing roster");

      try {
        state.selectedTaxa.clear();
        state.flippedTaxa.clear();
        state.rosterPage = 1;
        state.rosterSearch = "";
        state.rosterIconic = "";
        state.activeView = "home";
        els.rosterSearchInput.value = "";

        // Preferred: fetch your species in the browser; the Worker just persists
        // them. Falls back to the Worker fetch on any CORS/network/iNat hiccup.
        let speciesCounts = null;
        try {
          speciesCounts = await inatBrowserFetchSpeciesCounts(login, function (page) {
            setBusy(true, "Fetching your species from iNaturalist… (page " + page + ")");
          });
        } catch (browserErr) {
          speciesCounts = null;
        }

        const res = await apiFetch("/api/import", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(speciesCounts ? { speciesCounts: speciesCounts } : {})
        });

        state.userId = res.userId;
        state.inatLogin = res.inatLogin;
        localStorage.setItem("inatBattler:userId", state.userId);
        localStorage.setItem("inatBattler:inatLogin", state.inatLogin);
        setStatus((res.warning ? res.warning + " " : "") + "Imported " + res.importedTaxa + " taxa, queued " + res.queuedSprites + " sprites");
        await loadRoster();
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    async function initBlueskySession() {
      const params = new URLSearchParams(window.location.search);
      const authError = params.get("authError");
      if (authError) {
        setStatus("Bluesky sign-in failed: " + authError);
        window.history.replaceState({}, "", window.location.pathname);
      }

      const challengeId = params.get("challenge");
      if (challengeId) {
        try {
          state.challengeInfo = await apiFetch("/api/challenges/" + encodeURIComponent(challengeId));
        } catch (error) {
          setStatus(error.message);
        }
      }

      await refreshMe();
    }

    async function refreshMe() {
      try {
        state.me = await apiFetch("/api/me");
      } catch (error) {
        state.me = { loggedIn: false };
      }

      if (state.me.loggedIn) {
        try {
          const res = await apiFetch("/api/challenges");
          state.challenges = res.challenges || [];
        } catch (error) {
          state.challenges = [];
        }

        if (state.me.inatLogin) {
          await loadMySprites();
        }

        if (state.me.userId && state.me.userId !== state.userId) {
          state.userId = state.me.userId;
          state.inatLogin = state.me.inatLogin || "";
          localStorage.setItem("inatBattler:userId", state.userId);
          localStorage.setItem("inatBattler:inatLogin", state.inatLogin);
          els.input.value = state.inatLogin;
          try {
            await loadRoster();
          } catch (error) {
            setStatus(error.message);
          }
        }
      } else {
        state.challenges = [];
        state.training = null;
        if (state.activeView === "training") renderTraining();
      }

      renderBsky();
      renderLanding();
      renderHome();
    }

    function selectedTeamIds() {
      return Array.from(state.selectedTaxa).map(Number);
    }

    async function handleBskyAction(action, challengeId) {
      if (state.bskyBusy) return;
      state.bskyBusy = true;
      state.bskyAction = action || "";
      state.bskyMessage = bskyProgressMessage(action);
      state.bskyMessageKind = "info";
      els.bskyStateLabel.textContent = "working";
      if (action === "inat-confirm") renderBsky();

      try {
        if (action === "login") await bskyLogin();
        else if (action === "guest") await guestLogin();
        else if (action === "logout") await bskyLogout();
        else if (action === "inat-start") await inatLinkStart();
        else if (action === "inat-confirm") await inatLinkConfirm();
        else if (action === "inat-unlink") await inatUnlink();
        else if (action === "challenge-send") await sendChallenge();
        else if (action === "challenge-accept") await acceptChallengeAction(challengeId);
        else if (action === "challenge-decline") await declineChallengeAction(challengeId);
        else if (action === "battle-open") await openBattle(challengeId);
        else if (action === "sprite-upload") await uploadCustomSprite();
        else if (action === "sprites-sync") await syncMySprites();
      } catch (error) {
        state.bskyMessage = error.message;
        state.bskyMessageKind = "error";
        setStatus(error.message);
      } finally {
        state.bskyBusy = false;
        state.bskyAction = "";
        renderBsky();
        renderLanding();
        renderHome();
      }
    }

    function bskyProgressMessage(action) {
      if (action === "guest") return "Setting up a guest account.";
      if (action === "inat-confirm") return "Checking your iNaturalist profile for the verification code.";
      if (action === "inat-start") return "Creating a new iNaturalist verification code.";
      if (action === "inat-unlink") return "Unlinking your iNaturalist account.";
      if (action === "login") return "Contacting your Bluesky host.";
      if (action === "challenge-send") return "Creating and posting the Bluesky challenge.";
      if (action === "challenge-accept") return "Accepting the challenge and opening battle.";
      if (action === "challenge-decline") return "Declining the challenge.";
      if (action === "sprite-upload") return "Submitting your custom sprite for Discord QA.";
      if (action === "sprites-sync") return "Checking Discord QA reactions.";
      return "Working.";
    }

    function bskyBusyButtonText(action) {
      if (action === "guest") return "Starting...";
      if (action === "inat-confirm") return "Verifying...";
      if (action === "inat-start") return "Creating code...";
      if (action === "inat-unlink") return "Unlinking...";
      if (action === "login") return "Signing in...";
      if (action === "challenge-send") return "Sending...";
      if (action === "challenge-accept") return "Accepting...";
      if (action === "challenge-decline") return "Declining...";
      if (action === "sprite-upload") return "Submitting...";
      if (action === "sprites-sync") return "Refreshing...";
      return "Working...";
    }

    async function bskyLogin() {
      const inputs = Array.from(document.querySelectorAll("[data-bsky-login-input]"));
      const input = inputs.find((candidate) => candidate.offsetParent !== null) || inputs[0] || null;
      const handle = input ? input.value.trim() : "";
      if (!handle) {
        setStatus("Enter your Bluesky handle (like name.bsky.social).");
        return;
      }

      setStatus("Contacting your Bluesky host…");
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: handle, returnTo: window.location.pathname + window.location.search })
      });
      window.location.href = res.authorizeUrl;
    }

    // Play without Bluesky: the server creates a real (guest) account + session,
    // so linking iNaturalist, importing, battles, training, and territory all
    // work. Bluesky-only features stay locked until the guest connects Bluesky
    // (which carries the linked iNat account over).
    async function guestLogin() {
      await apiFetch("/api/auth/guest", { method: "POST" });
      state.bskyMessage = "";
      await refreshMe();
      await switchView("home");
      setStatus("Playing as a guest. Link your iNaturalist account to import your roster — you can connect Bluesky anytime.");
    }

    async function bskyLogout() {
      const wasGuest = Boolean(state.me && state.me.guest);
      await apiFetch("/api/auth/logout", { method: "POST" });
      state.me = { loggedIn: false };
      state.challenges = [];
      stopPresence();
      state.presence.buddies = new Map();
      if (state.activeView === "buddies") {
        els.buddiesPanel.innerHTML = '<p class="subtle">Sign in with Bluesky to see which of your mutuals are online.</p>';
        els.buddiesMetaLabel.textContent = "";
      }
      setStatus(wasGuest
        ? "Left guest mode. Your roster stays saved under your iNaturalist account — verify it again anytime to pick up where you left off."
        : "Signed out of Bluesky.");
    }

    async function inatLinkStart() {
      const inputs = Array.from(document.querySelectorAll("[data-inat-link-input]"));
      const activeInput = document.activeElement && document.activeElement.matches?.("[data-inat-link-input]")
        ? document.activeElement
        : null;
      const input = (activeInput && activeInput.value.trim() ? activeInput : null) ||
        inputs.find((candidate) => candidate.offsetParent !== null && candidate.value.trim()) ||
        inputs.find((candidate) => candidate.offsetParent !== null) ||
        inputs[0] ||
        null;
      const login = input ? input.value.trim() : "";
      if (!login) {
        setStatus("Enter your iNaturalist username first.");
        return;
      }

      await apiFetch("/api/inat/link/start", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ inatLogin: login })
      });
      state.bskyMessage = "Verification code created. Add it to your iNaturalist bio, save, then click Verify Link.";
      state.bskyMessageKind = "success";
      setStatus("Code created. Add it to your iNaturalist profile bio, save, then click Verify.");
      await refreshMe();
    }

    async function inatLinkConfirm() {
      setStatus("Checking your iNaturalist profile…");
      const res = await apiFetch("/api/inat/link/confirm", { method: "POST" });
      const importText = res.importStarted
        ? " Roster import is running in the background."
        : " Imported " + Number(res.importedTaxa || 0) + " taxa.";
      const message = "Linked iNaturalist account " + res.inatLogin + "." + importText + " You can remove the code from your bio now.";
      state.bskyMessage = message;
      state.bskyMessageKind = "success";
      // Show the first-import welcome summary on the Home dashboard once setup
      // completes (plan step 7). Cleared when the user dismisses it.
      state.showImportSummary = true;
      state.inatChangeOpen = false;
      state.me = {
        ...(state.me || {}),
        loggedIn: true,
        inatLogin: res.inatLogin,
        inatPendingLogin: null,
        inatVerificationCode: null,
        userId: res.userId || ("inat:" + String(res.inatLogin || "").toLowerCase())
      };
      state.userId = state.me.userId || state.userId;
      state.inatLogin = res.inatLogin || state.inatLogin;
      if (state.userId) localStorage.setItem("inatBattler:userId", state.userId);
      if (state.inatLogin) {
        localStorage.setItem("inatBattler:inatLogin", state.inatLogin);
        els.input.value = state.inatLogin;
      }
      renderBsky();
      setStatus(message);
      await refreshMe();
      if (res.importStarted) {
        window.setTimeout(() => {
          loadRoster().catch((error) => setStatus(error.message));
        }, 8000);
      }
    }

    async function inatUnlink() {
      await apiFetch("/api/inat/unlink", { method: "POST" });
      state.inatChangeOpen = false;
      // Detach the iNat identity locally too; the roster rows stay in D1 and are
      // restored by re-linking the same username. Mirrors refreshMe's clearing.
      state.userId = null;
      state.inatLogin = null;
      localStorage.removeItem("inatBattler:userId");
      localStorage.removeItem("inatBattler:inatLogin");
      if (state.me) {
        state.me.inatLogin = null;
        state.me.inatUserId = null;
        state.me.userId = null;
        state.me.inatPendingLogin = null;
        state.me.inatVerificationCode = null;
      }
      state.bskyMessage = "iNaturalist account unlinked. Your roster is saved — re-link the same username anytime to restore it.";
      state.bskyMessageKind = "success";
      setStatus("iNaturalist account unlinked.");
      await refreshMe();
    }

    async function sendChallenge() {
      const team = selectedTeamIds();
      if (team.length !== 5) {
        setStatus("Select exactly 5 ready sprites for your challenge team first.");
        return;
      }

      const handleInput = document.getElementById("challengeHandleInput");
      const messageInput = document.getElementById("challengeMessageInput");
      const opponentHandle = handleInput ? handleInput.value.trim() : "";
      if (!opponentHandle) {
        setStatus("Enter the opponent's Bluesky handle.");
        return;
      }

      setStatus("Creating challenge and posting to Bluesky…");
      const res = await apiFetch("/api/challenges", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          opponentHandle: opponentHandle,
          message: messageInput ? messageInput.value : "",
          taxonIds: team
        })
      });

      if (res.postError) {
        setStatus("Challenge saved, but the Bluesky post failed: " + res.postError);
      } else {
        setStatus("Challenge sent! Posted to Bluesky for @" + res.opponentHandle + ".");
      }
      await refreshMe();
    }

    async function acceptChallengeAction(challengeId) {
      if (!challengeId) return;
      const team = selectedTeamIds();
      if (team.length !== 5) {
        setStatus("Select exactly 5 ready sprites from your roster, then accept.");
        return;
      }

      const battle = await apiFetch("/api/challenges/" + encodeURIComponent(challengeId) + "/accept", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taxonIds: team })
      });

      if (state.challengeInfo && state.challengeInfo.challengeId === challengeId) {
        state.challengeInfo = null;
      }
      setStatus("Challenge accepted. Battle on!");
      enterBattle(battle);
      await refreshMe();
    }

    async function declineChallengeAction(challengeId) {
      if (!challengeId) return;
      await apiFetch("/api/challenges/" + encodeURIComponent(challengeId) + "/decline", { method: "POST" });
      if (state.challengeInfo && state.challengeInfo.challengeId === challengeId) {
        state.challengeInfo = null;
      }
      setStatus("Challenge declined.");
      await refreshMe();
    }

    async function openBattle(battleId) {
      if (!battleId) return;
      const battle = await apiFetch("/api/battles/" + encodeURIComponent(battleId));
      enterBattle(battle, { skipIntro: true });
    }

    async function loadMySprites() {
      try {
        const res = await apiFetch("/api/my-sprites");
        state.mySprites = res.submissions || [];
      } catch (error) {
        state.mySprites = [];
      }
    }

    async function uploadCustomSprite() {
      const input = document.getElementById("customSpriteFile");
      const file = input && input.files && input.files[0];
      const taxonInput = document.getElementById("customSpriteTaxonId");
      const manualTaxonInput = document.getElementById("manualTaxonId");
      const typedTaxonId = taxonInput ? taxonInput.value.trim() : "";
      const fallbackTaxonId = !typedTaxonId && manualTaxonInput ? manualTaxonInput.value.trim() : "";
      const rawTaxonId = typedTaxonId || fallbackTaxonId;
      if (!file) {
        throw new Error("Choose an image file first (PNG, JPEG, or WebP 4x4 sprite sheet).");
      }
      if (!rawTaxonId && state.selectedTaxa.size !== 1) {
        throw new Error("Enter an iNaturalist taxon ID in the Custom sprites field, or select one ready creature card.");
      }

      const typedTaxonMatch = rawTaxonId.match(/[0-9]+/);
      const taxonId = typedTaxonMatch ? typedTaxonMatch[0] : Array.from(state.selectedTaxa)[0];
      if (!taxonId || !/^[0-9]+$/.test(String(taxonId))) {
        throw new Error('Could not read a numeric iNaturalist taxon ID from "' + rawTaxonId + '".');
      }

      const form = new FormData();
      form.append("sprite", file);
      form.append("taxonId", String(taxonId));

      setStatus("Uploading custom sprite…");
      const res = await apiFetch("/api/my-sprites/upload", { method: "POST", body: form });
      const movesNote = res.moves?.generated
        ? " New image-matched moves: " + (res.moves.signatureMoves || []).join(", ") + "."
        : res.moves?.skipped
          ? ""
          : res.moves?.error
            ? " (Move generation failed: " + res.moves.error + ")"
            : "";
      const message = res.discordError
        ? "Sprite saved and live for you, but the Discord QA post failed: " + res.discordError + " (it will retry automatically)" + movesNote
        : "Custom sprite for " + res.name + " submitted for QA. It's live for you now; opponents see it once approved on Discord." + movesNote;
      if (res.discordError) {
        state.bskyMessageKind = "error";
      } else {
        state.bskyMessageKind = "success";
      }
      state.bskyMessage = message;
      setStatus(message);
      await loadMySprites();
      await loadRoster();
    }

    async function syncMySprites() {
      setStatus("Checking Discord QA reactions…");
      const res = await apiFetch("/api/sprite-submissions/sync", { method: "POST" });
      await loadMySprites();
      await loadRoster();
      setStatus("QA refresh: " + Number(res.approved || 0) + " approved, " + Number(res.rejected || 0) + " rejected, " + Number(res.checked || 0) + " checked.");
    }

    function renderMySpriteItem(item) {
      const badge = item.status === "approved" ? "✅" : item.status === "rejected" ? "❌" : "🕒";
      return '<div class="challenge-item">' +
        '<div>' + badge + ' <strong>' + escapeHtml(item.name) + '</strong> &mdash; ' + escapeHtml(item.status) +
        (item.discordError ? ' <span class="subtle">(Discord: ' + escapeHtml(item.discordError) + ')</span>' : '') +
        '</div>' +
      '</div>';
    }

    function renderCustomSpritePanel(busyAttr) {
      const list = state.mySprites.length
        ? state.mySprites.map(renderMySpriteItem).join("")
        : '<div class="challenge-item"><div class="subtle">No custom sprite submissions yet.</div></div>';

      return '<div class="bsky-section">' +
        '<div class="bsky-row">' +
          '<strong>Custom sprites</strong>' +
          '<button class="secondary" type="button" data-bsky-action="sprites-sync"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "sprites-sync" ? "Refreshing..." : "Refresh QA") +
          '</button>' +
        '</div>' +
        '<input id="customSpriteTaxonId" inputmode="numeric" placeholder="QA taxon ID, e.g. 145436">' +
        '<input id="customSpriteFile" type="file" accept="image/png,image/jpeg,image/webp">' +
        '<button class="primary" type="button" data-bsky-action="sprite-upload"' + busyAttr + '>' +
          (state.bskyBusy && state.bskyAction === "sprite-upload" ? "Submitting..." : "Submit for QA") +
        '</button>' +
        '<div class="batch-list">' + list + '</div>' +
      '</div>';
    }

    const TRAIN_STATS = ["vigor", "strike", "guard", "tempo", "sense"];

    async function loadTraining() {
      if (!state.me || !state.me.loggedIn || !state.me.inatLogin) {
        state.training = null;
        renderTraining();
        return;
      }

      try {
        state.training = await apiFetch("/api/training");
      } catch (error) {
        setStatus(error.message);
        state.training = null;
      }
      renderTraining();
    }

    async function syncTraining() {
      if (!state.me || !state.me.loggedIn || !state.me.inatLogin) {
        setStatus("Sign in with Bluesky and link your iNaturalist account first.");
        return;
      }
      if (state.trainingBusy) return;

      state.trainingBusy = true;
      els.trainingSyncButton.disabled = true;
      setStatus("Syncing iNaturalist training data...");

      try {
        // Fetch your RG species counts in your browser (per-user rate limit),
        // then hand them to the Worker; fall back to the Worker fetch on error.
        let speciesCounts = null;
        try {
          speciesCounts = await inatBrowserFetchSpeciesCounts(state.me.inatLogin, function (page) {
            setStatus("Fetching your Research Grade species from iNaturalist… (page " + page + ")");
          });
        } catch (browserErr) {
          speciesCounts = null;
        }
        const res = await apiFetch("/api/training/sync", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(speciesCounts ? { speciesCounts: speciesCounts } : {})
        });
        let message = "Synced: " + Number(res.rgSpeciesUpdated || 0) + " RG species, " +
          Number(res.taxaResolved || 0) + " taxa classified, " +
          Number(res.masteriesUpdated || 0) + " masteries updated.";
        if (res.provisionalSpeciesUpdated > 0) {
          message += " " + Number(res.provisionalSpeciesUpdated || 0) + " species using roster-count fallback.";
        }
        const rateLimited = /429|rate.?limit/i.test(String(res.warning || ""));
        if (res.unresolvedTaxa > 0) {
          message += " " + res.unresolvedTaxa + " taxa pending" +
            (rateLimited ? " - wait a minute before retrying." : " - sync again to continue.");
        }
        if (res.warning) message += " (" + res.warning + ")";
        setStatus(message);
        await loadTraining();
        state.rosterStale = true;
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.trainingBusy = false;
        els.trainingSyncButton.disabled = false;
      }
    }

    function replaceTrainingEntry(entry) {
      if (!state.training) return;
      const index = state.training.species.findIndex((candidate) => candidate.taxonId === entry.taxonId);
      if (index >= 0) state.training.species[index] = entry;

      const totals = { earned: 0, spent: 0, available: 0 };
      for (const species of state.training.species) {
        totals.earned += species.earned.total;
        totals.spent += species.spent;
        totals.available += species.available;
      }
      state.training.totals = totals;
    }

    async function allocateStat(taxonId, stat, amount) {
      if (state.trainingBusy) return;
      state.trainingBusy = true;

      try {
        const allocations = {};
        allocations[stat] = amount;
        const entry = await apiFetch("/api/training/allocate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taxonId: taxonId, allocations: allocations })
        });
        replaceTrainingEntry(entry);
        state.rosterStale = true;
        renderTraining();
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.trainingBusy = false;
      }
    }

    async function respecSpecies(taxonId) {
      if (state.trainingBusy) return;
      state.trainingBusy = true;

      try {
        const entry = await apiFetch("/api/training/respec", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taxonId: taxonId })
        });
        replaceTrainingEntry(entry);
        state.rosterStale = true;
        renderTraining();
        setStatus("Points refunded. Next free respec for this species in one week.");
      } catch (error) {
        setStatus(error.message);
      } finally {
        state.trainingBusy = false;
      }
    }

    async function saveNickname(taxonId) {
      const input = document.getElementById("trainNick-" + taxonId);
      if (!input) return;

      try {
        const res = await apiFetch("/api/training/nickname", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ taxonId: taxonId, nickname: input.value })
        });
        const entry = state.training && state.training.species.find((candidate) => String(candidate.taxonId) === String(taxonId));
        if (entry) entry.nickname = res.nickname;
        state.rosterStale = true;
        renderTraining();
        setStatus(res.nickname ? "Nickname saved: " + res.nickname : "Nickname cleared.");
      } catch (error) {
        setStatus(error.message);
      }
    }

    function renderMasteryCard(mastery) {
      const kindLabel = mastery.kind === "genus" ? "Genus" : "Family";
      const progress = mastery.total
        ? mastery.observed + " / " + mastery.total + " species"
        : mastery.observed + " observed species";
      const buffPct = Math.round((mastery.buffPct || 0) * 100);
      const extras = [];
      if (mastery.next) extras.push("next: " + mastery.next.tier + " at " + mastery.next.threshold);
      else if (mastery.tier === "gold" && mastery.total) extras.push("complete at " + mastery.total);
      if (buffPct > 0) extras.push("+" + buffPct + "% stats");

      return '<div class="mastery-card">' +
        '<div><span class="tier-chip tier-' + escapeAttr(mastery.tier) + '">' + escapeHtml(mastery.tier) + '</span> ' +
          '<strong>' + escapeHtml(mastery.name || kindLabel + " " + mastery.groupId) + '</strong> ' +
          '<span class="subtle">' + kindLabel + '</span></div>' +
        '<div class="subtle">' + escapeHtml(progress + (extras.length ? " · " + extras.join(" · ") : "")) + '</div>' +
      '</div>';
    }

    function renderTrainStatRow(entry, stat) {
      const data = entry.stats[stat];
      const baseWidth = Math.max(2, Math.min(100, data.base));
      const totalWidth = Math.max(baseWidth, Math.min(100, data.total));
      const capReached = data.allocated >= data.cap;
      const noPoints = entry.available <= 0;
      const label = stat.charAt(0).toUpperCase() + stat.slice(1);

      return '<div class="train-stat">' +
        '<span>' + escapeHtml(label) + '</span>' +
        '<div class="stat-track">' +
          '<span class="stat-alloc" style="width:' + totalWidth + '%"></span>' +
          '<span class="stat-base" style="width:' + baseWidth + '%"></span>' +
        '</div>' +
        '<span class="subtle">' + data.total + ' (+' + data.allocated + '/' + data.cap + ')</span>' +
        '<span>' +
          '<button class="train-add" type="button" data-train-add="' + escapeAttr(stat) + '" data-train-taxon="' + escapeAttr(String(entry.taxonId)) + '" data-train-amount="1" ' + (capReached || noPoints ? "disabled" : "") + '>+1</button> ' +
          '<button class="train-add" type="button" data-train-add="' + escapeAttr(stat) + '" data-train-taxon="' + escapeAttr(String(entry.taxonId)) + '" data-train-amount="5" ' + (data.allocated + 5 > data.cap || entry.available < 5 ? "disabled" : "") + '>+5</button>' +
        '</span>' +
      '</div>';
    }

    function renderTrainRow(entry) {
      const provisional = entry.countSource === "roster_fallback";
      const countLabel = provisional ? "provisional obs" : "RG";
      const ledger = "Earned " + entry.earned.total + " pts = " +
        entry.earned.base + " " + countLabel + " (sqrt of " + entry.rgObsCount + " obs) + " +
        entry.earned.firstBonus + " first + " +
        entry.earned.genusSpill + " genus + " +
        entry.earned.familySpill + " family + " +
        (entry.earned.genusBonus + entry.earned.familyBonus) + " mastery";
      const groupChips =
        (entry.genus && entry.genus.tier !== "none" ? ' <span class="tier-chip tier-' + escapeAttr(entry.genus.tier) + '">' + escapeHtml(entry.genus.name || "genus") + '</span>' : "") +
        (entry.family && entry.family.tier !== "none" ? ' <span class="tier-chip tier-' + escapeAttr(entry.family.tier) + '">' + escapeHtml(entry.family.name || "family") + '</span>' : "");
      const buffPct = Math.round((entry.buffPct || 0) * 100);
      const respecLabel = entry.canRespec
        ? "Respec"
        : entry.spent > 0 && entry.respecAvailableAt
          ? "Respec " + entry.respecAvailableAt.slice(0, 10)
          : "Respec";

      return '<div class="train-row">' +
        '<div class="train-head">' +
          '<strong>' + escapeHtml(entry.nickname || entry.name) + '</strong>' +
          (entry.nickname ? '<span class="subtle">' + escapeHtml(entry.name) + '</span>' : "") +
          '<span class="subtle">' + escapeHtml(entry.scientificName) + '</span>' +
          (entry.level > 0 ? '<span class="lv-chip">Lv ' + entry.level + '</span>' : "") +
          '<span class="chip">' + entry.available + ' pts</span>' +
          '<span class="chip">' + entry.rgObsCount + ' ' + escapeHtml(countLabel) + '</span>' +
          (buffPct > 0 ? '<span class="chip">+' + buffPct + '% mastery</span>' : "") +
          groupChips +
        '</div>' +
        '<div class="train-ledger">' + escapeHtml(ledger) + '</div>' +
        '<div class="train-stats">' + TRAIN_STATS.map((stat) => renderTrainStatRow(entry, stat)).join("") + '</div>' +
        '<div class="train-tools">' +
          '<input id="trainNick-' + escapeAttr(String(entry.taxonId)) + '" data-train-nick-input="' + escapeAttr(String(entry.taxonId)) + '" placeholder="Nickname (yours only)" maxlength="24" value="' + escapeAttr(entry.nickname || "") + '">' +
          '<button class="secondary" type="button" data-train-nick="' + escapeAttr(String(entry.taxonId)) + '">Save Name</button>' +
          '<button class="secondary" type="button" data-train-respec="' + escapeAttr(String(entry.taxonId)) + '" ' + (entry.canRespec ? "" : "disabled") + '>' + escapeHtml(respecLabel) + '</button>' +
        '</div>' +
      '</div>';
    }

    function renderTraining() {
      const training = state.training;
      const linked = state.me && state.me.loggedIn && state.me.inatLogin;

      els.trainingEmptyState.hidden = Boolean(training);
      els.trainingMasteries.hidden = !training;
      els.trainingSplit.hidden = !training;

      if (!training) {
        els.trainingTotalsLabel.textContent = "";
        els.trainingEmptyState.textContent = linked
          ? "Press Sync iNat Data to pull your iNaturalist observations and start earning points."
          : "To train creatures: sign in with Bluesky (sidebar), link your iNaturalist account, then press Sync iNat Data. Research Grade observations earn training points.";
        return;
      }

      els.trainingEmptyState.textContent = "";
      els.trainingTotalsLabel.textContent =
        training.totals.available + " pts available · " +
        training.totals.spent + " spent · " +
        training.totals.earned + " earned";

      els.trainingMasteriesSummary.textContent = training.masteries.length
        ? "Masteries (" + training.masteries.length + ")"
        : "Masteries";
      els.trainingMasteriesBody.innerHTML = training.masteries.length
        ? '<div class="mastery-grid">' + training.masteries.map(renderMasteryCard).join("") + '</div>'
        : '<div class="subtle" style="margin-top:10px">No genus or family progress yet. Observe more species, then sync.</div>';

      const filter = state.trainingFilter;
      const visible = filter
        ? training.species.filter((entry) => (
            (entry.name || "").toLowerCase().includes(filter) ||
            (entry.scientificName || "").toLowerCase().includes(filter) ||
            (entry.nickname || "").toLowerCase().includes(filter)
          ))
        : training.species;

      const selected = visible.find((entry) => String(entry.taxonId) === String(state.trainingSelected))
        || visible[0]
        || null;
      if (selected) state.trainingSelected = String(selected.taxonId);

      els.trainingList.innerHTML = visible.length
        ? visible.map((entry) => renderTrainingListRow(entry, selected)).join("")
        : '<div class="subtle" style="padding:10px">No species match the filter.</div>';

      els.trainingDetail.innerHTML = selected
        ? renderTrainRow(selected)
        : '<div class="empty">Select a species on the left to allocate training points.</div>';
    }

    function renderTrainingListRow(entry, selected) {
      const isActive = selected && String(entry.taxonId) === String(selected.taxonId);
      const sprite = entry.spriteUrl
        ? renderSheetSprite(entry.spriteUrl, "anim-idle")
        : '<div class="placeholder-shape placeholder-' + escapeAttr(placeholderFor(entry.iconicTaxonName)) + '"></div>';

      return '<button type="button" class="training-roster-row' + (isActive ? " active" : "") +
        '" data-train-select="' + escapeAttr(String(entry.taxonId)) + '" role="option" aria-selected="' + String(Boolean(isActive)) + '">' +
        '<span class="training-roster-sprite">' + sprite + '</span>' +
        '<span class="training-roster-copy">' +
          '<strong>' + escapeHtml(entry.nickname || entry.name) + '</strong>' +
          '<span class="subtle"><em>' + escapeHtml(entry.scientificName || "") + '</em></span>' +
        '</span>' +
        '<span class="training-roster-pts">' +
          (entry.level > 0 ? '<span>Lv ' + Number(entry.level) + '</span>' : '') +
          (entry.available > 0 ? '<span class="pts">' + Number(entry.available) + ' pts</span>' : '') +
        '</span>' +
      '</button>';
    }

    function renderChallengeBanner() {
      const info = state.challengeInfo;
      if (!info) return "";

      const me = state.me;
      const body = '<div><strong>@' + escapeHtml(info.challengerHandle) + '</strong> challenged <strong>@' +
        escapeHtml(info.opponentHandle) + '</strong>' +
        (info.message ? ': "' + escapeHtml(info.message) + '"' : " to an iNat Battle!") + '</div>';

      if (info.status !== "pending") {
        return '<div class="challenge-banner">' + body + '<div class="subtle">This challenge is ' + escapeHtml(info.status) + '.</div></div>';
      }
      if (!me || !me.loggedIn) {
        return '<div class="challenge-banner">' + body + '<div class="subtle">Sign in with Bluesky as @' + escapeHtml(info.opponentHandle) + ' to battle.</div></div>';
      }
      if (me.guest) {
        return '<div class="challenge-banner">' + body + '<div class="subtle">Challenges are answered with a Bluesky identity — connect Bluesky as @' + escapeHtml(info.opponentHandle) + ' to battle.</div></div>';
      }
      if (me.did !== info.opponentDid) {
        return '<div class="challenge-banner">' + body + '<div class="subtle">This challenge was sent to @' + escapeHtml(info.opponentHandle) + ', not your account.</div></div>';
      }

      const hint = me.inatLogin
        ? "Select 5 ready sprites from your roster, then accept."
        : "Link your iNaturalist account below, import your roster, select 5 sprites, then accept.";
      return '<div class="challenge-banner">' + body +
        '<div class="subtle">' + hint + '</div>' +
        '<div class="challenge-actions">' +
          '<button class="primary" type="button" data-bsky-action="challenge-accept" data-challenge-id="' + escapeAttr(info.challengeId) + '">Accept &amp; Battle</button>' +
          '<button class="secondary" type="button" data-bsky-action="challenge-decline" data-challenge-id="' + escapeAttr(info.challengeId) + '">Decline</button>' +
        '</div></div>';
    }

    function renderChallengeItem(challenge) {
      const isIncoming = challenge.direction === "incoming";
      const other = isIncoming ? challenge.challengerHandle : challenge.opponentHandle;
      let actions = "";

      if (isIncoming && challenge.status === "pending") {
        actions = '<div class="challenge-actions">' +
          '<button class="secondary" type="button" data-bsky-action="challenge-accept" data-challenge-id="' + escapeAttr(challenge.challengeId) + '">Accept</button>' +
          '<button class="secondary" type="button" data-bsky-action="challenge-decline" data-challenge-id="' + escapeAttr(challenge.challengeId) + '">Decline</button>' +
        '</div>';
      } else if (challenge.battleId && challenge.status === "accepted") {
        actions = '<div class="challenge-actions">' +
          '<button class="secondary" type="button" data-bsky-action="battle-open" data-challenge-id="' + escapeAttr(challenge.battleId) + '">Open Battle</button>' +
        '</div>';
      }

      return '<div class="challenge-item">' +
        '<div>' + (isIncoming ? "From" : "To") + ' <strong>@' + escapeHtml(other) + '</strong> &mdash; ' + escapeHtml(challenge.status) + '</div>' +
        actions +
      '</div>';
    }

    function renderTypeaheadInput(inputId, placeholder, enterAction) {
      const loginAttr = enterAction === "login" ? ' data-bsky-login-input="1"' : "";
      return '<div class="typeahead">' +
        '<input id="' + escapeAttr(inputId) + '" data-bsky-enter="' + escapeAttr(enterAction) + '" data-bsky-typeahead="1"' + loginAttr +
          ' placeholder="' + escapeAttr(placeholder) + '" autocomplete="off" spellcheck="false">' +
        '<div class="typeahead-list" hidden></div>' +
      '</div>';
    }

    function typeaheadListFor(input) {
      return input && input.parentElement ? input.parentElement.querySelector(".typeahead-list") : null;
    }

    function closeTypeaheadLists() {
      document.querySelectorAll(".typeahead-list").forEach((list) => {
        list.hidden = true;
        list.innerHTML = "";
      });
    }

    const runTypeahead = debounce(async (inputId, query) => {
      const input = document.getElementById(inputId);
      const list = typeaheadListFor(input);
      if (!input || !list) return;
      if (input.value.trim() !== query.trim()) return;

      let actors = [];
      try {
        const res = await apiFetch("/api/bsky/typeahead?q=" + encodeURIComponent(query.trim()));
        actors = res.actors || [];
      } catch (error) {
        actors = [];
      }

      if (input.value.trim() !== query.trim()) return;
      if (!actors.length) {
        list.hidden = true;
        list.innerHTML = "";
        return;
      }

      list.innerHTML = actors.map((actor) => (
        '<button type="button" class="typeahead-item" data-typeahead-pick="' + escapeAttr(actor.handle) + '" data-input-id="' + escapeAttr(inputId) + '">' +
          (actor.avatar
            ? '<img src="' + escapeAttr(actor.avatar) + '" alt="" loading="lazy">'
            : '<span class="typeahead-avatar"></span>') +
          '<span><strong>@' + escapeHtml(actor.handle) + '</strong>' +
            (actor.displayName ? ' ' + escapeHtml(actor.displayName) : '') +
          '</span>' +
        '</button>'
      )).join("");
      list.hidden = false;
    }, 250);

    function handleTypeaheadInput(input) {
      const query = input.value.trim().replace(/^@/, "");
      const list = typeaheadListFor(input);

      if (query.length < 2) {
        if (list) {
          list.hidden = true;
          list.innerHTML = "";
        }
        return;
      }
      runTypeahead(input.id, query);
    }

    function renderLanding() {
      if (!els.publicLanding || !els.appLayout || !els.landingAuth) return;

      const signedIn = Boolean(state.me && state.me.loggedIn);
      const showLanding = !state.userId && !signedIn;
      els.publicLanding.hidden = !showLanding;
      els.appLayout.hidden = showLanding;
      els.form.hidden = showLanding;
      document.body.classList.toggle("app-active", !showLanding);
      if (showLanding) els.mobileSheet.hidden = true;

      if (!showLanding) return;

      loadLandingSprites();
      setupAgentPrompt();

      const busyAttr = state.bskyBusy ? " disabled" : "";
      if (!state.me) {
        els.landingAuth.innerHTML = '<div class="landing-auth-note">Checking Bluesky session...</div>';
        return;
      }

      els.landingAuth.innerHTML =
        renderBskyStatus() +
        renderTypeaheadInput("landingBskyHandleInput", "you.bsky.social", "login") +
        '<button class="primary" type="button" data-bsky-action="login"' + busyAttr + '>' +
          (state.bskyBusy && state.bskyAction === "login" ? "Signing in..." : "Sign in with Bluesky") +
        '</button>' +
        '<div class="landing-auth-note">Uses Bluesky OAuth for identity and challenge posts. iNaturalist linking happens after sign-in.</div>' +
        '<div class="landing-auth-note landing-guest-note">No Bluesky account? ' +
          '<button class="link-button" type="button" data-bsky-action="guest"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "guest" ? "Starting..." : "Play without one") +
          '</button>' +
          ' — link just your iNaturalist account and battle NPCs, train, and claim territory. Challenges and buddies need Bluesky, and you can connect it later.</div>';
    }

    // Write text to the clipboard and briefly flip a button's label to "Copied!".
    async function copyWithFeedback(text, btn) {
      try {
        await navigator.clipboard.writeText(text);
        const prev = btn.textContent;
        btn.textContent = "Copied!";
        setTimeout(() => { btn.textContent = prev; }, 1500);
      } catch (_) {
        setStatus("Copy failed — select the text and copy it manually.");
      }
    }

    // Fill the "play with an AI agent" prompt with this deploy's origin and wire
    // its copy button. Runs once; the prompt lives in the static landing markup.
    function setupAgentPrompt() {
      if (state.agentPromptReady) return;
      const pre = document.getElementById("agentPromptText");
      const btn = document.getElementById("copyAgentPrompt");
      if (!pre || !btn) return;
      state.agentPromptReady = true;
      pre.textContent = pre.textContent.replace(/__ORIGIN__/g, location.origin);
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(pre.textContent);
          const prev = btn.textContent;
          btn.textContent = "Copied!";
          setTimeout(() => { btn.textContent = prev; }, 1500);
        } catch (_) {
          // Clipboard blocked: select the text so the user can copy manually.
          const range = document.createRange();
          range.selectNodeContents(pre);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
      });
    }

    // Populate the logged-out landing with a strip of real, recently generated
    // sprites so visitors see the actual collectible art before signing in. Loads
    // once; failures are silent (the landing still works without it).
    async function loadLandingSprites() {
      if (state.landingSpritesLoaded || !els.landingSprites) return;
      state.landingSpritesLoaded = true;
      try {
        const res = await apiFetch("/api/recent-sprites?limit=18");
        const sprites = (res.sprites || []).filter((s) => s.sprite && s.sprite.url).slice(0, 18);
        if (!sprites.length) return;
        els.landingSprites.innerHTML = sprites.map((s) =>
          '<div class="landing-sprite" title="' + escapeAttr(s.name || s.scientificName || "") + '">' +
            renderSheetSprite(s.sprite.url, "anim-idle") +
          '</div>'
        ).join("");
        if (els.landingGallery) els.landingGallery.hidden = false;
      } catch (e) {
        state.landingSpritesLoaded = false; // allow a retry on the next render
      }
    }

    function renderBskyStatus() {
      if (!state.bskyMessage) return "";
      return '<div class="bsky-status ' + escapeAttr(state.bskyMessageKind || "info") + '">' +
        escapeHtml(state.bskyMessage) +
      '</div>';
    }

    // The iNaturalist link/swap/unlink controls live in Settings → Account.
    function renderInatAccountBlock(me, busyAttr) {
      if (!me || !me.loggedIn) {
        return '<p class="subtle">Sign in with Bluesky first to link an iNaturalist account.</p>';
      }

      let html = "";
      // Show the verify form when not linked, when the user is mid-swap (a
      // pending login exists), or when they explicitly chose to change it.
      const showInatForm = !me.inatLogin || state.inatChangeOpen || Boolean(me.inatPendingLogin);

      if (me.inatLogin) {
        html += '<div class="bsky-row">' +
          '<div class="subtle">iNaturalist: <strong>' + escapeHtml(me.inatLogin) + '</strong> (verified)</div>' +
          '<span class="bsky-row-actions">' +
            '<button class="secondary" type="button" data-bsky-action="inat-change"' + busyAttr + '>Change</button>' +
            '<button class="secondary" type="button" data-bsky-action="inat-unlink"' + busyAttr + '>' +
              (state.bskyBusy && state.bskyAction === "inat-unlink" ? "Unlinking..." : "Unlink") +
            '</button>' +
          '</span>' +
        '</div>';
      }

      if (showInatForm) {
        html += '<div class="subtle">' +
          (me.inatLogin
            ? 'Switch to a different iNaturalist account by proving ownership (your current roster stays saved):'
            : 'Link your iNaturalist account by proving ownership &mdash; no iNat OAuth, no write access:') +
          '</div>' +
          '<input id="inatLinkInput" data-inat-link-input="1" data-bsky-enter="inat-start" placeholder="iNaturalist username" value="' + escapeAttr(me.inatPendingLogin || "") + '">' +
          '<button class="secondary" type="button" data-bsky-action="inat-start"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "inat-start" ? "Creating code..." : "Get verification code") +
          '</button>';

        if (me.inatPendingLogin && me.inatVerificationCode) {
          html += '<div class="bsky-code">' + escapeHtml(me.inatVerificationCode) + '</div>' +
            '<div class="subtle">Add this code to the profile bio of "' + escapeHtml(me.inatPendingLogin) +
            '" in <a href="https://www.inaturalist.org/users/edit" target="_blank" rel="noopener">iNaturalist settings</a>, save, then verify. You can remove it afterwards.</div>' +
            '<button class="primary" type="button" data-bsky-action="inat-confirm"' + busyAttr + '>' +
              (state.bskyBusy && state.bskyAction === "inat-confirm" ? "Verifying..." : "Verify Link") +
            '</button>';
        }

        if (me.inatLogin) {
          html += '<button class="secondary" type="button" data-bsky-action="inat-change-cancel"' + busyAttr + '>Cancel</button>';
        }
      }

      return html;
    }

    function renderInatSettings() {
      if (!els.settingsInatAccount) return;
      els.settingsInatAccount.innerHTML = renderInatAccountBlock(state.me, state.bskyBusy ? " disabled" : "");
    }

    async function loadApiKeys() {
      if (!els.apiKeyList) return;
      if (!(state.me && state.me.loggedIn)) {
        els.apiKeyList.innerHTML = '<p class="subtle">Sign in to manage API keys.</p>';
        return;
      }
      try {
        const res = await apiFetch("/api/account/api-keys");
        renderApiKeys(res.keys || []);
      } catch (error) {
        els.apiKeyList.innerHTML = '<p class="subtle">' + escapeHtml(error.message) + '</p>';
      }
    }

    function renderApiKeys(keys) {
      if (!keys.length) {
        els.apiKeyList.innerHTML = '<p class="subtle">No API keys yet.</p>';
        return;
      }
      els.apiKeyList.innerHTML = keys.map((key) => {
        const used = key.lastUsedAt ? "last used " + new Date(key.lastUsedAt).toLocaleDateString() : "never used";
        return '<div class="api-key-row">' +
          '<div><strong>' + escapeHtml(key.label) + '</strong>' +
            '<div class="subtle">' + escapeHtml(used) + '</div></div>' +
          '<button class="secondary" type="button" data-revoke-key="' + escapeAttr(key.apiKeyId) + '">Revoke</button>' +
        '</div>';
      }).join("");
    }

    async function createApiKeyFromInput() {
      const label = els.apiKeyLabelInput ? els.apiKeyLabelInput.value.trim() : "";
      els.apiKeyCreateButton.disabled = true;
      try {
        const res = await apiFetch("/api/account/api-keys", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ label })
        });
        if (els.apiKeyLabelInput) els.apiKeyLabelInput.value = "";
        els.apiKeyReveal.hidden = false;
        els.apiKeyReveal.innerHTML =
          '<p><strong>Copy this key now — it will not be shown again:</strong></p>' +
          '<div class="api-key-reveal-row">' +
            '<code class="api-key-token">' + escapeHtml(res.token) + '</code>' +
            '<button class="secondary" type="button" id="apiKeyCopyButton">Copy</button>' +
          '</div>';
        setStatus("API key created.");
        await loadApiKeys();
      } catch (error) {
        setStatus(error.message);
      } finally {
        els.apiKeyCreateButton.disabled = false;
      }
    }

    async function revokeApiKeyById(apiKeyId) {
      if (!apiKeyId) return;
      try {
        await apiFetch("/api/account/api-keys/" + encodeURIComponent(apiKeyId), { method: "DELETE" });
        setStatus("API key revoked.");
        await loadApiKeys();
      } catch (error) {
        setStatus(error.message);
      }
    }

    function renderBsky() {
      renderInatSettings();
      if (!els.bskyBody) return;
      const me = state.me;
      const busyAttr = state.bskyBusy ? " disabled" : "";

      if (!me) {
        els.bskyStateLabel.textContent = state.bskyBusy ? "working" : "loading";
        els.bskyBody.innerHTML = '<div class="subtle">Loading Bluesky session…</div>';
        return;
      }

      if (!me.loggedIn) {
        els.bskyStateLabel.textContent = state.bskyBusy ? "working" : "signed out";
        els.bskyBody.innerHTML =
          renderChallengeBanner() +
          renderBskyStatus() +
          renderTypeaheadInput("bskyHandleInput", "you.bsky.social", "login") +
          '<button class="primary" type="button" data-bsky-action="login"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "login" ? "Signing in..." : "Sign in with Bluesky") +
          '</button>' +
          '<div class="subtle">Uses AT Protocol OAuth (Bluesky and any compatible PDS) and only asks for permission to create posts.</div>';
        return;
      }

      els.bskyStateLabel.textContent = state.bskyBusy ? "working" : (me.guest ? "guest" : "@" + me.handle);

      let html = renderBskyStatus() +
      '<div class="bsky-row">' +
        '<strong>' + escapeHtml(me.guest ? "Guest naturalist" : (me.displayName || "@" + me.handle)) + '</strong>' +
        '<button class="secondary" type="button" data-bsky-action="logout"' + busyAttr + '>Sign out</button>' +
      '</div>';

      // Guests get the upgrade path where challenges would otherwise live.
      // Connecting Bluesky adopts the linked iNat account, so nothing is lost.
      if (me.guest) {
        html += '<div class="subtle"><strong>Connect Bluesky</strong> to challenge friends, see buddies online, and share victories. Your linked iNaturalist roster comes with you.</div>' +
          renderTypeaheadInput("bskyHandleInput", "you.bsky.social", "login") +
          '<button class="primary" type="button" data-bsky-action="login"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "login" ? "Signing in..." : "Connect Bluesky") +
          '</button>';
      }

      // iNaturalist linking/swap/unlink lives in Settings → Account to keep the
      // gameplay sidebar uncluttered. Just point there from here.
      if (me.inatLogin) {
        html += '<div class="subtle">iNaturalist: <strong>' + escapeHtml(me.inatLogin) + '</strong> &middot; ' +
          'manage in <button type="button" class="link-button" data-go-settings>Settings</button></div>';
      } else {
        html += '<div class="subtle">Link your iNaturalist account in ' +
          '<button type="button" class="link-button" data-go-settings>Settings → Account</button> to import your roster.</div>';
      }

      html += renderChallengeBanner();

      if (me.inatLogin && !me.guest) {
        html += '<div class="subtle"><strong>Challenge a player</strong> (uses your selected 5)</div>' +
          renderTypeaheadInput("challengeHandleInput", "opponent.bsky.social", "challenge-send") +
          '<input id="challengeMessageInput" placeholder="Optional taunt (140 chars)" maxlength="140">' +
          '<button class="primary" type="button" data-bsky-action="challenge-send"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "challenge-send" ? "Sending..." : "Send Challenge via Bluesky") +
          '</button>';
      }

      // Custom sprite uploads only need a linked iNat account (Discord QA),
      // so guests get them too.
      if (me.inatLogin) {
        html += renderCustomSpritePanel(busyAttr);
      }

      if (state.challenges.length) {
        html += '<div class="batch-list">' + state.challenges.map(renderChallengeItem).join("") + '</div>';
      }

      els.bskyBody.innerHTML = html;
    }

    async function loadRoster() {
      const rosterUserId = state.viewUserId || state.userId;
      if (!rosterUserId) return;

      const params = new URLSearchParams({
        userId: rosterUserId,
        limit: String(ROSTER_PAGE_SIZE),
        offset: String((state.rosterPage - 1) * ROSTER_PAGE_SIZE)
      });
      if (state.rosterSearch) params.set("q", state.rosterSearch);
      if (state.rosterSort !== "default") params.set("sort", state.rosterSort);
      if (state.rosterStatus !== "all") params.set("status", state.rosterStatus);
      if (state.rosterIconic) params.set("iconic", state.rosterIconic);

      const res = await apiFetch("/api/roster?" + params.toString());
      state.taxa = res.taxa || [];
      state.rosterTotal = Number(res.total ?? state.taxa.length);
      state.rosterSummary = res.summary || null;
      state.rosterIconicCounts = Array.isArray(res.iconicCounts) ? res.iconicCounts : [];

      const pageCount = Math.max(1, Math.ceil(state.rosterTotal / ROSTER_PAGE_SIZE));
      if (state.taxa.length === 0 && state.rosterPage > pageCount) {
        state.rosterPage = pageCount;
        return loadRoster();
      }

      pruneSelectedTaxa();
      updateRosterViewBanner();
      render();
      schedulePolling();
    }

    function updateRosterViewBanner() {
      if (!els.rosterViewBanner) return;
      document.body.dataset.viewingOther = state.viewUserId ? "1" : "";
      if (!state.viewUserId) {
        els.rosterViewBanner.hidden = true;
        els.rosterViewBanner.innerHTML = "";
        return;
      }
      els.rosterViewBanner.hidden = false;
      els.rosterViewBanner.innerHTML =
        '<span>Viewing <strong>' + escapeHtml(state.viewLabel || state.viewUserId) + '</strong>’s roster (read-only)</span>' +
        '<button class="secondary" type="button" data-roster-view-exit>Back to my roster</button>';
    }

    async function enterRosterView(userId, label) {
      const target = String(userId || "").trim();
      if (!target) return;
      // No-op if it's actually the signed-in user.
      if (target === state.userId) {
        await exitRosterView();
        return;
      }
      state.viewUserId = target;
      state.viewLabel = label || target.replace(/^inat:/, "");
      state.rosterPage = 1;
      state.activeView = "roster";
      renderViewTabs();
      if (els.rosterLookupInput) els.rosterLookupInput.value = "";
      try {
        await loadRoster();
        if (!state.taxa.length) {
          setStatus("No roster found for “" + state.viewLabel + "”. They may not be in iNat Battler yet.");
        }
      } catch (error) {
        setStatus(error.message);
      }
    }

    async function exitRosterView() {
      if (!state.viewUserId) return;
      state.viewUserId = null;
      state.viewLabel = "";
      state.rosterPage = 1;
      try {
        await loadRoster();
      } catch (error) {
        setStatus(error.message);
      }
    }

    function lookupRosterFromInput() {
      const raw = els.rosterLookupInput ? els.rosterLookupInput.value.trim() : "";
      const login = raw.replace(/^@/, "").trim();
      if (!login) {
        setStatus("Enter an iNaturalist username to view their roster.");
        return;
      }
      enterRosterView("inat:" + login.toLowerCase(), login);
    }

    async function reloadRosterPage(resetPage) {
      if (resetPage) state.rosterPage = 1;
      state.pollDelayMs = 0; // user action: restart the sprite poll cadence
      try {
        await loadRoster();
      } catch (error) {
        setStatus(error.message);
      }
    }

    async function switchView(view) {
      // Viewing another player's roster is modal to the roster tab; any tab
      // switch returns to the signed-in owner's data.
      const wasViewing = Boolean(state.viewUserId);
      if (wasViewing) {
        state.viewUserId = null;
        state.viewLabel = "";
        state.rosterPage = 1;
        updateRosterViewBanner();
        if (state.userId) {
          try {
            await loadRoster();
          } catch (error) {
            setStatus(error.message);
          }
        }
      }

      state.activeView = ["home", "roster", "tree", "recent", "battle", "leaderboard", "buddies", "map", "training", "settings"].includes(view) ? view : "home";
      renderViewTabs();

      if (state.activeView === "map") {
        initTerritoryMap();
      }

      if (state.activeView === "leaderboard") {
        await loadLeaderboard(!state.leaderboard);
      }
      if (state.activeView === "buddies") {
        startPresence(false);
      }
      if (state.activeView === "tree" && !state.spriteTree) {
        await loadSpriteTree(false);
      }
      if (state.activeView === "recent" && !state.recentSprites) {
        await loadRecentSprites(false);
      }
      if (state.activeView === "training" && !state.training) {
        await loadTraining();
      }
      if ((state.activeView === "home" || state.activeView === "roster") && state.rosterStale && state.userId) {
        state.rosterStale = false;
        try {
          await loadRoster();
        } catch (error) {
          setStatus(error.message);
        }
      }
    }

    function renderViewTabs() {
      const view = state.activeView;
      document.body.dataset.view = view;
      for (const button of document.querySelectorAll("[data-view-tab]")) {
        if (button.getAttribute("data-view-tab") === view) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
      els.homeTabButton.classList.toggle("active", view === "home");
      els.rosterTabButton.classList.toggle("active", view === "roster");
      els.battleTabButton.classList.toggle("active", view === "battle");
      els.leaderboardTabButton.classList.toggle("active", view === "leaderboard");
      els.buddiesTabButton.classList.toggle("active", view === "buddies");
      els.mapTabButton.classList.toggle("active", view === "map");
      els.trainingTabButton.classList.toggle("active", view === "training");
      els.treeTabButton.classList.toggle("active", view === "tree");
      els.recentTabButton.classList.toggle("active", view === "recent");
      els.settingsTabButton.classList.toggle("active", view === "settings");
      els.homeView.hidden = view !== "home";
      els.rosterView.hidden = view !== "roster";
      els.battleView.hidden = view !== "battle";
      els.leaderboardView.hidden = view !== "leaderboard";
      els.buddiesView.hidden = view !== "buddies";
      els.mapView.hidden = view !== "map";
      els.trainingView.hidden = view !== "training";
      els.treeView.hidden = view !== "tree";
      els.recentView.hidden = view !== "recent";
      els.settingsView.hidden = view !== "settings";
      if (view === "settings") {
        els.settingsSoundToggle.checked = state.soundOn;
        const linked = !!(state.me && state.me.loggedIn && state.me.inatLogin);
        els.settingsHighlightOptIn.checked = !!(state.me && state.me.allowHighlightBot);
        els.settingsHighlightOptIn.disabled = !linked;
        renderInatSettings();
        loadApiKeys();
      }
      els.battleTabButton.textContent = state.battle && state.battle.status === "active" ? "Battle ⚔" : "Battle";

      const primaryMobileViews = ["home", "roster", "battle", "buddies"];
      for (const button of els.mobileNav.querySelectorAll("[data-mobile-nav]")) {
        const isActive = button.getAttribute("data-mobile-nav") === view;
        button.classList.toggle("active", isActive);
        if (isActive) button.setAttribute("aria-current", "page");
        else button.removeAttribute("aria-current");
      }
      els.mobileMoreButton.classList.toggle("active", !primaryMobileViews.includes(view));
      for (const button of els.mobileSheet.querySelectorAll("[data-mobile-nav]")) {
        button.classList.toggle("active", button.getAttribute("data-mobile-nav") === view);
      }
    }

    // -- Territory map (Leaflet) --------------------------------------------

    const BIOME_COLORS = {
      shrubland: "#ccb35c", grassland: "#b8e05c", agricultural: "#e9d35f",
      urban: "#e60000", desert: "#c4b79f", polar: "#f0f0f0", freshwater: "#3a86d6",
      wetland: "#13b3b3", tundra: "#7dd67d", forest: "#3bbf57", woodland: "#7cc873",
      ocean: "#2e6f9e", unknown: "#808080"
    };
    const TAXA_COLORS = {
      Aves: "#3b82f6", Plantae: "#22c55e", Insecta: "#f59e0b", Fungi: "#a855f7",
      Mammalia: "#ef4444", Reptilia: "#84cc16", Amphibia: "#14b8a6", Arachnida: "#f97316",
      Mollusca: "#ec4899", Actinopterygii: "#06b6d4", Animalia: "#eab308", unknown: "#9ca3af"
    };
    const MAP_TILE_MIN_ZOOM = 6;

    function biomeColor(b) { return BIOME_COLORS[b] || BIOME_COLORS.unknown; }
    function taxaColor(t) { return TAXA_COLORS[t] || TAXA_COLORS.unknown; }

    function renderMapLegend() {
      const order = ["forest", "woodland", "grassland", "shrubland", "wetland", "freshwater", "ocean", "agricultural", "urban", "desert", "tundra", "polar"];
      let html = "";
      for (let i = 0; i < order.length; i += 1) {
        html += '<span class="map-legend-row"><span class="map-legend-sw" style="background:' + biomeColor(order[i]) + '"></span>' + order[i] + "</span>";
      }
      els.mapLegend.innerHTML = html;
    }

    // Leaflet + protomaps are only needed by this tab, so they are fetched on
    // first open instead of shipping with every page view. Leaflet is required;
    // the protomaps biome layer stays optional (the map degrades gracefully).
    let mapLibsPromise = null;
    function loadExternalScript(src) {
      return new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = src;
        script.crossOrigin = "";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load " + src));
        document.head.appendChild(script);
      });
    }
    function ensureMapLibraries() {
      if (typeof L !== "undefined") return Promise.resolve();
      if (!mapLibsPromise) {
        const css = document.createElement("link");
        css.rel = "stylesheet";
        css.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
        css.crossOrigin = "";
        document.head.appendChild(css);
        mapLibsPromise = loadExternalScript("https://unpkg.com/leaflet@1.9.4/dist/leaflet.js")
          .then(() => loadExternalScript("https://unpkg.com/protomaps-leaflet@4.0.1/dist/protomaps-leaflet.js")
            .catch(() => { /* biome basemap is optional */ }))
          .catch((error) => {
            mapLibsPromise = null; // allow a retry on the next tab open
            throw error;
          });
      }
      return mapLibsPromise;
    }

    async function initTerritoryMap() {
      if (state.map) {
        setTimeout(() => { state.map.invalidateSize(); }, 60);
        return;
      }
      if (state.mapInitializing) return;
      state.mapInitializing = true;
      try {
        if (typeof L === "undefined") {
          els.mapStatusLabel.textContent = "Loading the map…";
          await ensureMapLibraries();
          els.mapStatusLabel.textContent = "Your observations on the living map. Each hex is a real biome.";
        }
      } catch (error) {
        els.mapStatusLabel.textContent = "Couldn't load the map — check your connection and reopen this tab.";
        return;
      } finally {
        state.mapInitializing = false;
      }
      if (state.map) return;
      const map = L.map(els.mapCanvas, { zoomControl: true, preferCanvas: false, worldCopyJump: true });
      state.map = map;
      state.mapTileLayer = L.layerGroup().addTo(map);
      state.mapClaimLayer = L.layerGroup().addTo(map);
      state.mapObsLayer = L.layerGroup().addTo(map);
      state.mapAvatarLayer = L.layerGroup().addTo(map);
      L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: "&copy; OpenStreetMap &copy; CARTO",
        subdomains: "abcd",
        maxZoom: 19
      }).addTo(map);

      // Biome basemap: vector hexes from a single PMTiles archive (range-read
      // client-side), styled by biome — LOD/global handled by the tile pyramid.
      if (typeof protomapsL !== "undefined") {
        try {
          state.biomeLayer = protomapsL.leafletLayer({
            // ?v bumps when the tileset is rebuilt, to bust browser/edge cache.
            url: "/tiles/biomes.pmtiles?v=5",
            // The archive carries crisp biome hexes at every scale: res2 (z0-2),
            // res3 (z3-4), res5 (z5-11) — the finest hexes kick in early (z5).
            // PMTiles is range-read, so each view only pulls its viewport's tiles.
            // It lives in Leaflet's tilePane, below the overlayPane res5 claimable
            // grid (API) — biome fill paints the base, claimable hexes overlay on
            // top, no blank gap when a wide viewport exceeds the res5 API cell cap.
            maxDataZoom: 11,
            paintRules: [{
              dataLayer: "biomes",
              minzoom: 0,
              maxzoom: 15,
              symbolizer: new protomapsL.PolygonSymbolizer({
                fill: (z, f) => biomeColor(f.props.biome),
                opacity: 0.5
              })
            }],
            backgroundColor: "rgba(0,0,0,0)"
          });
          state.biomeLayer.addTo(map);
        } catch (error) { /* fall back to no biome layer */ }
      }

      map.setView([20, 0], 2);
      renderMapLegend();

      let debounce = null;
      map.on("moveend", () => {
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(loadMapData, 350);
      });

      // Click the biome basemap -> resolve the res5 cell -> open the tile panel.
      map.on("click", async (event) => {
        if (state.map.getZoom() < 8) {
          els.mapStatusLabel.textContent = "Zoom in to claim a tile.";
          return;
        }
        try {
          const res = await apiFetch("/api/territory/cell?lat=" + event.latlng.lat + "&lng=" + event.latlng.lng);
          if (res && res.h3) openTilePanel(res.h3);
        } catch (error) { /* ignore */ }
      });

      setTimeout(() => {
        map.invalidateSize();
        centerMapOnObservations();
      }, 90);
    }

    async function centerMapOnObservations() {
      if (!state.map) return;
      try {
        const res = await apiFetch("/api/territory/observations");
        const obs = (res && res.observations) || [];
        if (obs.length > 0) {
          const lats = obs.map((o) => o.latitude);
          const lngs = obs.map((o) => o.longitude);
          state.map.fitBounds(
            [[Math.min.apply(null, lats), Math.min.apply(null, lngs)], [Math.max.apply(null, lats), Math.max.apply(null, lngs)]],
            { padding: [30, 30], maxZoom: 9 }
          );
        } else {
          els.mapStatusLabel.textContent = "No observations synced yet — tap “Sync my observations.”";
        }
      } catch (error) {
        /* fall through to a normal load */
      }
      loadMapData();
    }

    let mapLoadToken = 0;
    async function loadMapData() {
      if (!state.map) return;
      const token = (mapLoadToken += 1);
      const b = state.map.getBounds();
      const zoom = Math.round(state.map.getZoom());
      const qs = "n=" + b.getNorth() + "&s=" + b.getSouth() + "&e=" + b.getEast() + "&w=" + b.getWest();
      const claims = state.mapMode === "claims";

      // World→regional biomes come from the PMTiles basemap (z<8). At local zoom
      // the res5 grid (claimable, ownership-aware) is drawn from the API.
      if (zoom >= 8) {
        try {
          const tres = await apiFetch("/api/territory/tiles?" + qs + "&zoom=" + zoom);
          if (token !== mapLoadToken) return;
          drawTiles((tres && tres.tiles) || [], 5, claims);
        } catch (error) { /* ignore */ }
      } else {
        state.mapTileLayer.clearLayers();
      }

      if (claims) {
        state.mapObsLayer.clearLayers();
        try {
          const cres = await apiFetch("/api/territory/claims?" + qs);
          if (token !== mapLoadToken) return;
          await drawClaims((cres && cres.claims) || []);
        } catch (error) { /* ignore */ }
      } else {
        state.mapClaimLayer.clearLayers();
        state.mapAvatarLayer.clearLayers();
        try {
          const ores = await apiFetch("/api/territory/observations?" + qs);
          if (token !== mapLoadToken) return;
          drawObservations((ores && ores.observations) || []);
        } catch (error) { /* ignore */ }
      }
    }

    // --- Claims mode: owner-colored territory + PFP cluster markers ---

    function hashColor(str) {
      let h = 0;
      const s = String(str || "");
      for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 360;
      return "hsl(" + h + ", 65%, 55%)";
    }

    // Dominant color of a Bluesky avatar (most-populated coarse RGB bucket,
    // ignoring near-black/near-white). Falls back to a hash color if the image
    // is CORS-tainted or fails to load.
    function rgbToHsl(r, g, b) {
      r /= 255; g /= 255; b /= 255;
      const mx = Math.max(r, g, b);
      const mn = Math.min(r, g, b);
      let h = 0;
      let s = 0;
      const l = (mx + mn) / 2;
      const d = mx - mn;
      if (d) {
        s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
        if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
        else if (mx === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
      }
      return [h, s, l];
    }

    // Dominant *characteristic* color of an avatar: weight pixels by saturation
    // AND brightness (so a vivid logo/garment beats a big muted background),
    // pick the strongest hue bucket, then re-render it at a fixed tile-friendly
    // lightness so it reads on the dark map (the raw pixel can be a dark brown).
    function avatarDominantColor(url) {
      return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => {
          try {
            const S = 32;
            const canvas = document.createElement("canvas");
            canvas.width = S;
            canvas.height = S;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(img, 0, 0, S, S);
            const data = ctx.getImageData(0, 0, S, S).data;
            const buckets = {};
            let best = null;
            for (let i = 0; i < data.length; i += 4) {
              const r = data[i];
              const g = data[i + 1];
              const bl = data[i + 2];
              if (data[i + 3] < 128) continue;
              const mx = Math.max(r, g, bl);
              const mn = Math.min(r, g, bl);
              if (mx < 40) continue;
              const sat = mx === 0 ? 0 : (mx - mn) / mx;
              if (sat < 0.28) continue; // skip near-grayscale (backgrounds)
              const w = sat * (mx / 255);
              const key = (r >> 5) + "," + (g >> 5) + "," + (bl >> 5);
              const bk = buckets[key] || (buckets[key] = { r: 0, g: 0, b: 0, w: 0 });
              bk.r += r * w; bk.g += g * w; bk.b += bl * w; bk.w += w;
              if (!best || bk.w > best.w) best = bk;
            }
            if (!best) { resolve(null); return; }
            const hsl = rgbToHsl(best.r / best.w, best.g / best.w, best.b / best.w);
            const sat = Math.round(Math.max(0.55, hsl[1]) * 100);
            resolve("hsl(" + Math.round(hsl[0]) + ", " + sat + "%, 55%)");
          } catch (error) {
            resolve(null);
          }
        };
        img.onerror = () => resolve(null);
        img.src = url;
      });
    }

    // Union-find clustering by centroid proximity (res5 hex spacing ~0.16deg).
    function clusterByProximity(tiles) {
      const parent = tiles.map((_, i) => i);
      const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
      const union = (a, b) => { parent[find(a)] = find(b); };
      const THRESH = 0.26;
      for (let i = 0; i < tiles.length; i += 1) {
        for (let j = i + 1; j < tiles.length; j += 1) {
          const a = tiles[i].centroid;
          const c = tiles[j].centroid;
          const dLat = a[0] - c[0];
          const dLng = (a[1] - c[1]) * Math.cos((a[0] * Math.PI) / 180);
          if (Math.sqrt(dLat * dLat + dLng * dLng) < THRESH) union(i, j);
        }
      }
      const groups = {};
      for (let i = 0; i < tiles.length; i += 1) {
        const root = find(i);
        (groups[root] || (groups[root] = [])).push(tiles[i]);
      }
      return Object.keys(groups).map((k) => groups[k]);
    }

    function ownerAvatarHtml(owner, color) {
      const inner = owner.avatarUrl
        ? '<img src="' + escapeAttr(owner.avatarUrl) + '" alt="" referrerpolicy="no-referrer">'
        : '<span class="owner-avatar-fallback">' + escapeHtml((owner.handle || "?").charAt(0).toUpperCase()) + '</span>';
      return '<div class="owner-avatar-ring" style="border-color:' + color + '">' + inner + '</div>';
    }

    async function drawClaims(claims) {
      // Biome grid stays (drawn by drawTiles); we overlay claims + avatars.
      state.mapClaimLayer.clearLayers();
      state.mapAvatarLayer.clearLayers();
      if (!claims.length) {
        els.mapStatusLabel.textContent = "Faint hexes are unclaimed — claim one to plant your flag.";
        return;
      }

      if (!state.ownerColors) state.ownerColors = {};
      const byDid = {};
      for (const claim of claims) (byDid[claim.did] || (byDid[claim.did] = [])).push(claim);
      const dids = Object.keys(byDid);

      await Promise.all(dids.map(async (did) => {
        if (state.ownerColors[did] !== undefined) return;
        const sample = byDid[did][0];
        let color = null;
        if (sample.avatarUrl) {
          // Read pixels through the same-origin proxy so the canvas isn't tainted.
          color = await avatarDominantColor("/api/avatar?url=" + encodeURIComponent(sample.avatarUrl));
        }
        state.ownerColors[did] = color || hashColor(did);
      }));

      for (const claim of claims) {
        const color = state.ownerColors[claim.did] || "#888";
        const poly = L.polygon(claim.boundary, {
          fillColor: color,
          // Near-opaque so the owner color is exact, not tinted by the biome
          // hex underneath (same owner -> same color regardless of habitat).
          fillOpacity: 0.95,
          color: claim.mine ? "#ffffff" : color,
          weight: claim.mine ? 2 : 1
        });
        const habitat = claim.biome ? escapeHtml(claim.biome) + " · " : "";
        poly.bindTooltip(habitat + "@" + escapeHtml(claim.handle), { sticky: true });
        const h3 = claim.h3;
        poly.on("click", () => openTilePanel(h3));
        state.mapClaimLayer.addLayer(poly);
      }

      for (const did of dids) {
        const color = state.ownerColors[did] || "#888";
        const owner = byDid[did][0];
        for (const cluster of clusterByProximity(byDid[did])) {
          let lat = 0;
          let lng = 0;
          for (const tile of cluster) { lat += tile.centroid[0]; lng += tile.centroid[1]; }
          lat /= cluster.length;
          lng /= cluster.length;
          const icon = L.divIcon({
            className: "owner-avatar-icon",
            html: ownerAvatarHtml(owner, color),
            iconSize: [46, 46],
            iconAnchor: [23, 23]
          });
          L.marker([lat, lng], { icon, title: "@" + owner.handle, interactive: false }).addTo(state.mapAvatarLayer);
        }
      }

      els.mapStatusLabel.textContent = claims.length + " claimed tiles · " + dids.length + " holder" + (dids.length === 1 ? "" : "s") + " in view.";
    }

    function setMapMode(mode) {
      state.mapMode = mode === "claims" ? "claims" : "biomes";
      if (els.mapModeToggle) {
        for (const button of els.mapModeToggle.querySelectorAll("[data-map-mode]")) {
          button.classList.toggle("active", button.getAttribute("data-map-mode") === state.mapMode);
        }
      }
      if (state.map) loadMapData();
    }

    function drawTiles(tiles, resolution, dim) {
      state.mapTileLayer.clearLayers();
      const claimable = resolution === 5;
      for (let i = 0; i < tiles.length; i += 1) {
        const t = tiles[i];
        if (!t.boundary || !t.boundary.length) continue;
        const poly = L.polygon(t.boundary, {
          fillColor: biomeColor(t.biome),
          fillOpacity: dim ? 0.22 : (t.mine ? 0.72 : 0.5),
          color: dim ? "rgba(255,255,255,0.12)" : (t.mine ? "#ffffff" : "rgba(255,255,255,0.35)"),
          weight: t.mine && !dim ? 2.5 : 1,
          interactive: claimable
        });
        poly.bindTooltip(t.biome + (t.mine ? " — yours" : ""), { sticky: true });
        if (claimable) {
          const h3 = t.h3;
          poly.on("click", () => openTilePanel(h3));
        }
        state.mapTileLayer.addLayer(poly);
      }
      // Keep observation points clickable above the hexes just drawn.
      state.mapObsLayer.eachLayer((layer) => { if (layer.bringToFront) layer.bringToFront(); });
      els.mapStatusLabel.textContent = tiles.length + " biome hexes in view"
        + (resolution !== 5 ? " (zoom in to claim)" : "") + ".";
    }

    function drawObservations(obs) {
      state.mapObsLayer.clearLayers();
      for (let i = 0; i < obs.length; i += 1) {
        const o = obs[i];
        if (!Number.isFinite(o.latitude) || !Number.isFinite(o.longitude)) continue;
        const marker = L.circleMarker([o.latitude, o.longitude], {
          radius: 6,
          fillColor: taxaColor(o.iconic_taxon_name),
          fillOpacity: 0.95,
          color: "#ffffff",
          weight: 1.2
        });
        const name = o.taxon_name || "Observation";
        marker.bindPopup('<strong>' + escapeHtml(name) + '</strong><br><span class="subtle">' + escapeHtml(o.iconic_taxon_name || '') + '</span>');
        state.mapObsLayer.addLayer(marker);
        marker.bringToFront();
      }
    }

    // iNaturalist v2 observation fields the territory ingest needs. Mirrors the
    // server INAT_OBSERVATION_GEO_FIELDS so browser-fetched rows match.
    var INAT_OBS_GEO_FIELDS = "id,observed_on,time_observed_at,quality_grade,geoprivacy,taxon_geoprivacy,obscured,location,geojson,taxon.id,taxon.name,taxon.preferred_common_name,taxon.iconic_taxon_name";

    // Fetch the signed-in user's research-grade geo observations straight from
    // iNaturalist in their OWN browser (iNat v2 sends CORS headers for GET), so
    // the iNat rate limit lands on each user's IP instead of funneling every
    // user through the Worker's shared egress. Returns the raw v2 rows.
    async function inatBrowserFetchObservations(login, onProgress) {
      const MAX_PAGES = 10;
      const rows = [];
      for (let page = 1; page <= MAX_PAGES; page += 1) {
        if (onProgress) onProgress(page);
        const params = new URLSearchParams({
          user_login: login,
          quality_grade: "research",
          geo: "true",
          order_by: "observed_on",
          per_page: "200",
          page: String(page),
          fields: INAT_OBS_GEO_FIELDS,
          ttl: "21600"
        });
        const res = await fetch("https://api.inaturalist.org/v2/observations?" + params.toString());
        if (!res.ok) throw new Error("iNaturalist returned " + res.status);
        const data = await res.json();
        const pageRows = (data && Array.isArray(data.results)) ? data.results : [];
        for (let i = 0; i < pageRows.length; i += 1) rows.push(pageRows[i]);
        if (pageRows.length < 200) break;
        // Be polite between pages (the Worker fallback waits ~1.1s).
        await new Promise(function (resolve) { setTimeout(resolve, 700); });
      }
      return rows;
    }

    async function syncTerritory() {
      els.mapSyncButton.disabled = true;
      els.mapStatusLabel.textContent = "Syncing observations from iNaturalist…";
      try {
        let res = null;
        const login = (state.me && state.me.inatLogin) || state.inatLogin;
        if (login) {
          // Preferred path: fetch in the user's browser, then hand the rows to
          // the Worker just to persist them (keeps iNat rate limits per-user).
          try {
            const obs = await inatBrowserFetchObservations(login, function (page) {
              els.mapStatusLabel.textContent = "Fetching your observations from iNaturalist… (page " + page + ")";
            });
            els.mapStatusLabel.textContent = "Saving " + obs.length + " observations…";
            res = await apiFetch("/api/territory/ingest", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ observations: obs })
            });
          } catch (browserErr) {
            // CORS/network/iNat hiccup -> let the Worker fetch instead.
            res = null;
          }
        }
        if (!res) {
          res = await apiFetch("/api/territory/sync", { method: "POST" });
        }
        if (res && res.warning) {
          els.mapStatusLabel.textContent = res.warning;
        } else {
          els.mapStatusLabel.textContent = "Synced " + Number(res.recorded || 0) + " observations across " + Number(res.distinctTiles || 0) + " tiles.";
        }
        await centerMapOnObservations();
      } catch (error) {
        els.mapStatusLabel.textContent = error.message || "Sync failed";
      } finally {
        els.mapSyncButton.disabled = false;
      }
    }

    function closeTilePanel() {
      els.tilePanel.hidden = true;
      els.tilePanel.innerHTML = "";
    }

    function openTilePanel(h3) {
      els.tilePanel.hidden = false;
      els.tilePanel.innerHTML = '<div class="tile-panel-body"><p class="subtle">Loading tile…</p></div>';
      apiFetch("/api/territory/tile?h3=" + encodeURIComponent(h3))
        .then(renderTilePanel)
        .catch((error) => {
          els.tilePanel.innerHTML = '<div class="tile-panel-body"><button class="tile-close" type="button" data-tile-close aria-label="Close">×</button><p class="subtle">' + escapeHtml(error.message || "Failed to load tile") + '</p></div>';
        });
    }

    function renderTilePanel(d) {
      const name = d.biome.charAt(0).toUpperCase() + d.biome.slice(1);
      const teamReady = state.selectedTaxa && state.selectedTaxa.size === 5;
      let ownerLine;
      if (d.mine) ownerLine = '<span class="tile-owner mine">★ You hold this tile</span>';
      else if (d.owned) ownerLine = '<span class="tile-owner">Held by @' + escapeHtml(d.owner) + '</span>';
      else ownerLine = '<span class="tile-owner">Unclaimed</span>';

      const favored = (d.favoredTypes && d.favoredTypes.length)
        ? '<p class="subtle">Favors ' + escapeHtml(d.favoredTypes.join(" · ")) + ' moves (+15%)</p>'
        : "";

      // Roster power: holdings of this biome buff your biome-native species.
      const holdings = (Number(d.biomeBuffPct) > 0)
        ? '<p class="tile-power">🏞️ You hold ' + Number(d.biomeHoldings) + ' ' + escapeHtml(d.biome) +
          ' tiles → <strong>+' + Math.round(Number(d.biomeBuffPct) * 100) + '%</strong> to your ' +
          escapeHtml(d.biome) + '-native species in battle.</p>'
        : (Number(d.biomeHoldings) === 0
          ? '<p class="subtle">Hold ' + escapeHtml(d.biome) + ' tiles to buff your ' + escapeHtml(d.biome) + '-native species.</p>'
          : "");

      // Local presence: distinct RG species you've observed here vs. the gate.
      const localLine = '<p class="tile-local' + (d.eligible ? ' ok' : '') + '">📍 ' + Number(d.localSpecies) +
        ' / ' + Number(d.speciesNeeded) + ' research-grade species observed here' +
        (d.eligible ? ' — your locals fight +' + Math.round(0.04 * 100) + '%' : '') + '.</p>';

      const garrisonBtn = (label, cls) => '<button class="' + cls + '" type="button" data-tile-garrison="' + escapeAttr(d.h3) + '">' + label + '</button>';
      let action;
      if (d.mine && d.pending) {
        // You just took it — undefended on the clock.
        action = '<p class="tile-warn">⏳ Undefended — ' + Number(d.minutesLeft) + 'm left to garrison or it reverts to neutral.</p>' +
          (teamReady ? garrisonBtn("Garrison with my 5", "primary") : '<p class="tile-hint">Select 5 ready creatures in Roster, then garrison.</p>');
      } else if (d.mine) {
        action = '<p class="tile-hint">Defended by your garrison (defense ' + Number(d.defenseStrength) + ').</p>' +
          (teamReady ? garrisonBtn("Re-garrison with my 5", "secondary") : "");
      } else if (!d.eligible) {
        action = '<p class="tile-hint">Observe ' + Math.max(0, Number(d.speciesNeeded) - Number(d.localSpecies)) +
          ' more research-grade species here to claim or contest this tile.</p>';
      } else if (d.canClaim) {
        action = '<button class="primary" type="button" data-tile-claim="' + escapeAttr(d.h3) + '">Claim this tile</button>';
      } else if (d.pending) {
        // Owned by someone else but undefended — contest-locked grace window.
        action = '<p class="tile-hint">Just taken by @' + escapeHtml(d.owner || "someone") + ' — its defenses are being set up.</p>';
      } else if (d.canContest) {
        action = teamReady
          ? '<button class="primary" type="button" data-tile-contest="' + escapeAttr(d.h3) + '">Contest — battle the garrison' + (Number(d.defenseStrength) > 0 ? " (def +" + Number(d.defenseStrength) + ")" : "") + '</button>'
          : '<p class="tile-hint">Select 5 ready creatures in Roster to contest.</p>';
      } else {
        action = "";
      }

      els.tilePanel.hidden = false;
      els.tilePanel.innerHTML =
        '<div class="tile-panel-body">' +
          '<button class="tile-close" type="button" data-tile-close aria-label="Close">×</button>' +
          '<div class="tile-head"><span class="tile-biome-chip" style="background:' + biomeColor(d.biome) + '"></span>' +
          '<h3>' + escapeHtml(name) + ' tile</h3></div>' +
          ownerLine +
          favored +
          localLine +
          holdings +
          action +
          '<p class="subtle tile-actions-left">' + Number(d.actionsLeftToday) + ' actions left today</p>' +
        '</div>';
    }

    async function claimTile(h3) {
      try {
        await apiFetch("/api/territory/claim", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ h3: h3 })
        });
        els.mapStatusLabel.textContent = "Tile claimed — garrison it before the timer runs out.";
        openTilePanel(h3);
        loadMapData();
      } catch (error) {
        els.mapStatusLabel.textContent = error.message || "Claim failed";
      }
    }

    async function garrisonTile(h3) {
      const taxonIds = Array.from(state.selectedTaxa || []).map(Number);
      if (taxonIds.length !== 5) { els.mapStatusLabel.textContent = "Select 5 ready creatures in Roster first."; return; }
      try {
        await apiFetch("/api/territory/garrison", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ h3: h3, taxonIds: taxonIds })
        });
        els.mapStatusLabel.textContent = "Tile garrisoned — it's defended now.";
        openTilePanel(h3);
        loadMapData();
      } catch (error) {
        els.mapStatusLabel.textContent = error.message || "Garrison failed";
      }
    }

    async function contestTile(h3) {
      const taxonIds = Array.from(state.selectedTaxa || []).map(Number);
      if (taxonIds.length !== 5) { els.mapStatusLabel.textContent = "Select 5 ready creatures first."; return; }
      try {
        const battle = await apiFetch("/api/territory/contest", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ h3: h3, taxonIds: taxonIds })
        });
        closeTilePanel();
        enterBattle(battle);
      } catch (error) {
        els.mapStatusLabel.textContent = error.message || "Contest failed";
      }
    }

    function treeClientCacheKey(q) {
      return String(q || "").trim().toLowerCase();
    }

    function pickTreeLoadingMessage() {
      return TREE_LOADING_MESSAGES[Math.floor(Math.random() * TREE_LOADING_MESSAGES.length)];
    }

    function startSpriteTreeLoading(showStatus) {
      if (state.spriteTreeMessageTimer) clearInterval(state.spriteTreeMessageTimer);
      state.spriteTreeLoading = true;
      state.spriteTreeError = "";
      state.spriteTreeMessage = pickTreeLoadingMessage();
      if (showStatus) setStatus("Loading sprite tree");
      renderSpriteTree();
      state.spriteTreeMessageTimer = setInterval(() => {
        state.spriteTreeMessage = pickTreeLoadingMessage();
        if (state.activeView === "tree" && state.spriteTreeLoading) renderSpriteTree();
      }, 4000);
    }

    function stopSpriteTreeLoading() {
      state.spriteTreeLoading = false;
      if (state.spriteTreeMessageTimer) {
        clearInterval(state.spriteTreeMessageTimer);
        state.spriteTreeMessageTimer = null;
      }
    }

    function rememberSpriteTree(cacheKey, tree) {
      state.spriteTreeCache.set(cacheKey, { createdAt: Date.now(), tree: tree });
      if (state.spriteTreeCache.size > 8) {
        const oldestKey = state.spriteTreeCache.keys().next().value;
        if (oldestKey) state.spriteTreeCache.delete(oldestKey);
      }
    }

    async function loadSpriteTree(showStatus) {
      const q = state.treeSearch || "";
      const requestId = state.spriteTreeRequestId + 1;
      state.spriteTreeRequestId = requestId;
      const cacheKey = treeClientCacheKey(q);
      const cached = state.spriteTreeCache.get(cacheKey);
      if (cached && Date.now() - cached.createdAt < TREE_CLIENT_CACHE_TTL_MS) {
        const previousQuery = state.spriteTree?.q || "";
        state.spriteTree = cached.tree;
        state.spriteTreeError = "";
        stopSpriteTreeLoading();
        syncTreePath(cached.tree, q, previousQuery);
        renderSpriteTree();
        if (showStatus) setStatus("Loaded " + Number(cached.tree.totalSprites || 0) + " ready sprites in the tree");
        return;
      }

      startSpriteTreeLoading(showStatus);

      try {
        const previousQuery = state.spriteTree?.q || "";
        const res = await apiFetch("/api/sprite-tree?limit=1000&q=" + encodeURIComponent(q));
        if (requestId !== state.spriteTreeRequestId) return;
        state.spriteTree = res;
        state.spriteTreeError = "";
        rememberSpriteTree(cacheKey, res);
        syncTreePath(res, q, previousQuery);
        if (showStatus) setStatus("Loaded " + Number(res.totalSprites || 0) + " ready sprites in the tree");
      } catch (error) {
        if (requestId !== state.spriteTreeRequestId) return;
        state.spriteTreeError = error.message || "Could not load sprite tree";
        setStatus(state.spriteTreeError);
      } finally {
        if (requestId === state.spriteTreeRequestId) {
          stopSpriteTreeLoading();
          renderSpriteTree();
        }
      }
    }

    async function loadRecentSprites(showStatus) {
      const q = state.recentSearch || "";
      if (showStatus) setStatus("Loading recently added sprites");

      try {
        const res = await apiFetch("/api/recent-sprites?limit=100&q=" + encodeURIComponent(q));
        state.recentSprites = res;
        renderRecentSprites();
        if (showStatus) setStatus("Loaded " + Number(res.totalSprites || 0) + " recently added sprites");
      } catch (error) {
        setStatus(error.message);
      }
    }

    async function loadLeaderboard(showStatus) {
      if (showStatus) setStatus("Loading leaderboard");
      const territory = state.leaderboardMode === "territory";
      try {
        const board = await apiFetch(territory ? "/api/leaderboard/territory" : "/api/leaderboard");
        if (territory) state.territoryLeaderboard = board;
        else state.leaderboard = board;
        renderLeaderboard();
        if (showStatus) setStatus("Leaderboard updated");
      } catch (error) {
        setStatus(error.message);
      }
    }

    function setLeaderboardMode(mode) {
      state.leaderboardMode = mode === "territory" ? "territory" : "battle";
      for (const button of els.leaderboardModeToggle.querySelectorAll("[data-lb-mode]")) {
        button.classList.toggle("active", button.getAttribute("data-lb-mode") === state.leaderboardMode);
      }
      const cached = state.leaderboardMode === "territory" ? state.territoryLeaderboard : state.leaderboard;
      if (cached) renderLeaderboard();
      else loadLeaderboard(true);
    }

    function streakHtml(entry) {
      if (Number(entry.winStreak) >= 2) {
        return '<span class="lb-streak">' + Number(entry.winStreak) + 'W streak 🔥</span>';
      }
      return "";
    }

    function lbAvatar(entry) {
      return entry.avatarUrl
        ? '<img class="lb-avatar" src="' + escapeAttr(entry.avatarUrl) + '" alt="" loading="lazy">'
        : '<span class="lb-avatar" aria-hidden="true"></span>';
    }

    function lbDisplayName(entry) {
      const name = escapeHtml(entry.name || entry.userId);
      const handle = entry.handle ? ' <span class="subtle">@' + escapeHtml(entry.handle) + '</span>' : "";
      if (entry.userId) {
        const label = entry.name || entry.handle || entry.userId;
        return '<button type="button" class="lb-name-link" data-view-roster="' + escapeAttr(entry.userId) +
          '" data-view-label="' + escapeAttr(label) + '" title="View this naturalist’s roster">' + name + '</button>' + handle;
      }
      return name + handle;
    }

    function renderLeaderboard() {
      if (state.leaderboardMode === "territory") {
        renderTerritoryLeaderboard();
        return;
      }
      const board = state.leaderboard;
      if (!board) {
        els.leaderboardPanel.innerHTML = "";
        return;
      }

      const entries = board.entries || [];
      els.leaderboardMetaLabel.textContent = entries.length
        ? board.totalPlayers + " ranked naturalist" + (board.totalPlayers === 1 ? "" : "s")
        : "";

      if (!entries.length) {
        els.leaderboardPanel.innerHTML =
          '<div class="empty"><div><strong>The leaderboard is unclaimed.</strong><br>' +
          'Win a rated NPC battle and the #1 spot is yours — someone has to found the food chain.</div></div>';
        return;
      }

      const medals = ["🥇", "🥈", "🥉"];
      const podiumClasses = ["first", "second", "third"];
      const podium = entries.slice(0, 3).map((entry, index) =>
        '<div class="lb-podium-card ' + podiumClasses[index] + '">' +
          '<div class="lb-medal">' + medals[index] + '</div>' +
          lbAvatar(entry) +
          '<div class="lb-name">' + lbDisplayName(entry) + '</div>' +
          '<div class="lb-rating">' + entry.rating + '</div>' +
          '<span class="lb-title-chip">' + escapeHtml(entry.titleEmoji + " " + entry.title) + '</span>' +
          '<div class="subtle">' + entry.wins + 'W / ' + entry.losses + 'L</div>' +
          streakHtml(entry) +
        '</div>'
      ).join("");

      const youId = board.you ? board.you.userId : null;
      const tableRows = entries.slice(3).map((entry) =>
        '<tr' + (entry.userId === youId ? ' class="lb-you"' : "") + '>' +
          '<td>#' + entry.rank + '</td>' +
          '<td><span class="lb-row-name">' + lbAvatar(entry) + lbDisplayName(entry) + '</span></td>' +
          '<td><span class="lb-title-chip">' + escapeHtml(entry.titleEmoji + " " + entry.title) + '</span></td>' +
          '<td><strong>' + entry.rating + '</strong></td>' +
          '<td>' + entry.wins + 'W / ' + entry.losses + 'L</td>' +
          '<td>' + (Number(entry.winStreak) >= 2 ? streakHtml(entry) : "&mdash;") + '</td>' +
          '<td>' + (entry.fastestWinTurns ? entry.fastestWinTurns + " turns" : "&mdash;") + '</td>' +
        '</tr>'
      ).join("");
      const table = entries.length > 3
        ? '<table class="lb-table"><thead><tr>' +
            '<th>Rank</th><th>Naturalist</th><th>Title</th><th>Score</th><th>Record</th><th>Streak</th><th>Fastest win</th>' +
          '</tr></thead><tbody>' + tableRows + '</tbody></table>'
        : "";

      let youCard = "";
      if (board.you) {
        const you = board.you;
        youCard =
          '<div class="lb-you-card">' +
            '<div class="lb-you-stats">' +
              '<span class="lb-you-rank">#' + you.rank + '</span>' +
              '<span class="lb-title-chip">' + escapeHtml(you.titleEmoji + " " + you.title) + '</span>' +
              '<strong>' + you.rating + '</strong>' +
              '<span class="subtle">' + you.wins + 'W / ' + you.losses + 'L &middot; best streak ' + you.bestStreak + '</span>' +
              streakHtml(you) +
            '</div>' +
            (state.me && state.me.guest
              ? '<span class="subtle">Connect Bluesky (sidebar) to post your rank.</span>'
              : '<button class="secondary bsky-share-button" type="button" data-share-rank>Post my rank to Bluesky 🦋</button>') +
          '</div>';
      } else if (state.me && state.me.loggedIn && state.me.inatLogin) {
        youCard = '<div class="lb-you-card"><span class="subtle">Win a rated NPC battle to enter the rankings.</span></div>';
      } else {
        youCard = '<div class="lb-you-card"><span class="subtle">Sign in and link your iNaturalist account to get ranked.</span></div>';
      }

      els.leaderboardPanel.innerHTML = '<div class="lb-podium">' + podium + '</div>' + table + youCard;
    }

    function renderTerritoryLeaderboard() {
      const board = state.territoryLeaderboard;
      if (!board) {
        els.leaderboardPanel.innerHTML = "";
        return;
      }
      const entries = board.entries || [];
      els.leaderboardMetaLabel.textContent = entries.length
        ? board.totalPlayers + " landholder" + (board.totalPlayers === 1 ? "" : "s")
        : "";

      if (!entries.length) {
        els.leaderboardPanel.innerHTML =
          '<div class="empty"><div><strong>No territory claimed yet.</strong><br>' +
          'Open the Map, sync your observations, and claim a tile to top this board.</div></div>';
        return;
      }

      const biomeChip = (b) => b
        ? '<span class="lb-title-chip">' + escapeHtml(b.charAt(0).toUpperCase() + b.slice(1)) + '</span>'
        : "&mdash;";
      const medals = ["🥇", "🥈", "🥉"];
      const podiumClasses = ["first", "second", "third"];
      const podium = entries.slice(0, 3).map((entry, index) =>
        '<div class="lb-podium-card ' + podiumClasses[index] + '">' +
          '<div class="lb-medal">' + medals[index] + '</div>' +
          lbAvatar(entry) +
          '<div class="lb-name">' + lbDisplayName(entry) + '</div>' +
          '<div class="lb-rating">' + entry.tiles + '</div>' +
          '<div class="subtle">tiles</div>' +
          biomeChip(entry.topBiome) +
          '<div class="subtle">' + entry.biomes + ' biome' + (entry.biomes === 1 ? "" : "s") + '</div>' +
        '</div>'
      ).join("");

      const youId = board.you ? board.you.userId : null;
      const tableRows = entries.slice(3).map((entry) =>
        '<tr' + (entry.userId === youId ? ' class="lb-you"' : "") + '>' +
          '<td>#' + entry.rank + '</td>' +
          '<td><span class="lb-row-name">' + lbAvatar(entry) + lbDisplayName(entry) + '</span></td>' +
          '<td><strong>' + entry.tiles + '</strong></td>' +
          '<td>' + entry.biomes + '</td>' +
          '<td>' + biomeChip(entry.topBiome) + '</td>' +
        '</tr>'
      ).join("");
      const table = entries.length > 3
        ? '<table class="lb-table"><thead><tr>' +
            '<th>Rank</th><th>Holder</th><th>Tiles</th><th>Biomes</th><th>Top biome</th>' +
          '</tr></thead><tbody>' + tableRows + '</tbody></table>'
        : "";

      let youCard;
      if (board.you) {
        const you = board.you;
        youCard =
          '<div class="lb-you-card"><div class="lb-you-stats">' +
            '<span class="lb-you-rank">#' + you.rank + '</span>' +
            '<strong>' + you.tiles + ' tiles</strong>' +
            '<span class="subtle">' + you.biomes + ' biome' + (you.biomes === 1 ? "" : "s") +
              (you.topBiome ? " &middot; mostly " + escapeHtml(you.topBiome) : "") + '</span>' +
          '</div></div>';
      } else if (state.me && state.me.loggedIn && state.me.inatLogin) {
        youCard = '<div class="lb-you-card"><span class="subtle">Claim a tile on the Map to enter the territory rankings.</span></div>';
      } else {
        youCard = '<div class="lb-you-card"><span class="subtle">Sign in and link iNaturalist, then claim tiles to get ranked.</span></div>';
      }

      els.leaderboardPanel.innerHTML = '<div class="lb-podium">' + podium + '</div>' + table + youCard;
    }

    function formatHomeNumber(value) {
      return Number(value || 0).toLocaleString();
    }

    function currentRosterSummary() {
      const summary = state.rosterSummary || {};
      const pageReady = state.taxa.filter((taxon) => taxon.sprite.status === "ready").length;
      const pagePending = state.taxa.filter((taxon) => ["queued", "running", "batch_submitted"].includes(taxon.sprite.status)).length;
      const totalCount = Number(summary.totalCount ?? state.rosterTotal ?? state.taxa.length);
      const readyCount = Number(summary.readyCount ?? pageReady);
      const pendingCount = Number(summary.pendingCount ?? pagePending);
      const failedCount = Number(summary.failedCount ?? 0);
      const missingCount = Number(summary.missingCount ?? Math.max(0, totalCount - readyCount - pendingCount - failedCount));

      return {
        totalCount,
        readyCount,
        pendingCount,
        failedCount,
        missingCount,
        observationTotal: Number(summary.observationTotal ?? state.taxa.reduce((sum, taxon) => sum + Number(taxon.obsCount || 0), 0)),
        affinityTotal: Number(summary.affinityTotal ?? state.taxa.reduce((sum, taxon) => sum + Number(affinityLevel(taxon) || 0), 0)),
        trainingSpent: Number(summary.trainingSpent ?? 0)
      };
    }

    function homeNextStep(summary, selectedCount) {
      if (!state.me || !state.me.loggedIn) {
        return {
          title: "Sign in with Bluesky",
          body: "Use the Bluesky panel to sign in before sending or accepting player challenges.",
          action: null,
          label: ""
        };
      }

      if (!state.me.inatLogin) {
        return {
          title: "Verify your iNaturalist account",
          body: "Use the Bluesky panel to create a profile code, verify ownership, and import your observations.",
          action: null,
          label: ""
        };
      }

      if (!summary.totalCount) {
        return {
          title: "Import your observations",
          body: "Enter your iNaturalist username in the top bar to build your species roster.",
          action: null,
          label: ""
        };
      }

      if (summary.readyCount < 5) {
        return {
          title: "Get five ready sprites",
          body: "You need at least five ready sprites to battle. Queue missing sprites or use the ready species already available.",
          action: "ready-roster",
          label: "Show Ready Species"
        };
      }

      if (selectedCount < 5) {
        return {
          title: "Pick your battle team",
          body: "Select " + (5 - selectedCount) + " more ready " + (5 - selectedCount === 1 ? "species" : "species") + " to open battle options.",
          action: "ready-roster",
          label: "Pick Ready Species"
        };
      }

      return {
        title: "Team ready",
        body: "Your five-species team is selected. Start an NPC battle or send a Bluesky challenge.",
        action: "start-battle",
        label: "Battle NPC"
      };
    }

    // One-time welcome summary shown on the Home dashboard right after a player
    // finishes setup (verify + import). Numbers update live as sprites generate.
    function renderImportSummary(summary, handle) {
      const total = summary.totalCount || 0;
      const ready = summary.readyCount || 0;
      const queued = summary.pendingCount || 0;
      const stillWorking = total === 0 || queued > 0 || ready < Math.min(5, total);
      const teamLine = ready >= 5
        ? "You have enough ready sprites to field a full five-species team."
        : (total === 0
          ? "Your species are importing now — they'll appear here as they finish."
          : Math.max(0, 5 - ready) + " more ready " + (5 - ready === 1 ? "sprite" : "sprites") + " and you can field a full team.");
      return '<section class="import-summary">' +
        '<button class="import-summary-dismiss" type="button" data-home-action="dismiss-import" aria-label="Dismiss">×</button>' +
        '<div class="subtle">Setup complete</div>' +
        '<h2>Roster ready, ' + escapeHtml(handle) + '!</h2>' +
        '<p>' + escapeHtml(teamLine) + (stillWorking ? " Sprite generation runs in the background; these numbers update as it finishes." : "") + '</p>' +
        '<div class="import-summary-stats">' +
          importStat(total, "Taxa imported") +
          importStat(ready, "Sprites ready") +
          importStat(queued, "Queued") +
        '</div>' +
        '<div class="home-actions">' +
          '<button class="primary" type="button" data-home-action="ready-roster">Pick your team</button>' +
          '<button class="secondary" type="button" data-home-action="dismiss-import">Go to Home</button>' +
        '</div>' +
      '</section>';
    }

    function importStat(value, label) {
      return '<div class="import-stat">' +
        '<strong>' + escapeHtml(String(value)) + '</strong>' +
        '<span>' + escapeHtml(label) + '</span>' +
      '</div>';
    }

    function renderHome() {
      if (!els.homeDashboard) return;

      if (state.me?.loggedIn && !state.me.inatLogin) {
        els.homeDashboard.innerHTML = renderOnboardingHome();
        return;
      }

      const summary = currentRosterSummary();
      const selectedCount = state.selectedTaxa.size;
      const readyPct = summary.totalCount > 0 ? Math.round((summary.readyCount / summary.totalCount) * 100) : 0;
      const next = homeNextStep(summary, selectedCount);
      const handle = state.me?.handle ? "@" + state.me.handle : (state.inatLogin ? "@" + state.inatLogin : "Field naturalist");
      const groupText = state.rosterIconicCounts.length
        ? state.rosterIconicCounts.slice(0, 4).map((row) => row.iconic + " " + row.count).join(" / ")
        : "Import a roster to see your largest groups.";

      els.homeDashboard.innerHTML =
        (state.showImportSummary ? renderImportSummary(summary, handle) : "") +
        '<section class="home-hero-card">' +
          '<div class="home-copy">' +
            '<div class="subtle">Player Home</div>' +
            '<h2>' + escapeHtml(handle) + '</h2>' +
            '<p>Manage your observed-species roster, pick a five-creature team, train favorites, and jump into battles without scrolling through the full collection first.</p>' +
            '<div class="home-actions">' +
              '<button class="primary" type="button" data-home-action="ready-roster">Pick Team</button>' +
              '<button class="secondary" type="button" data-home-action="training">Training</button>' +
              '<button class="secondary" type="button" data-home-action="recent">Recently Added</button>' +
            '</div>' +
          '</div>' +
          '<div class="home-next">' +
            '<span class="subtle">Next Action</span>' +
            '<strong>' + escapeHtml(next.title) + '</strong>' +
            '<p>' + escapeHtml(next.body) + '</p>' +
            (next.action ? '<button class="primary" type="button" data-home-action="' + escapeAttr(next.action) + '">' + escapeHtml(next.label) + '</button>' : '') +
          '</div>' +
        '</section>' +
        '<section class="home-metrics" aria-label="Roster summary">' +
          renderHomeMetric("Taxa", summary.totalCount, "Imported species") +
          renderHomeMetric("Ready", summary.readyCount, readyPct + "% battle-art ready") +
          renderHomeMetric("Queued", summary.pendingCount, "Sprite jobs active") +
          renderHomeMetric("Missing", summary.missingCount, "Need generated art") +
        '</section>' +
        '<section class="home-panels">' +
          '<div class="home-panel wide">' +
            '<div>' +
              '<h3>Battle Team</h3>' +
              '<p>' + selectedCount + ' / 5 ready species selected.</p>' +
            '</div>' +
            renderHomeTeamSlots() +
            '<div class="home-actions">' +
              '<button class="secondary" type="button" data-home-action="ready-roster">Edit Team</button>' +
              '<button class="primary" type="button" data-home-action="start-battle"' + (selectedCount === 5 ? "" : " disabled") + '>Battle NPC</button>' +
            '</div>' +
          '</div>' +
          '<div class="home-panel wide">' +
            '<div>' +
              '<h3>Ready Picks</h3>' +
              '<p>Quick-add ready species from the current roster page.</p>' +
            '</div>' +
            renderHomeReadyPicks() +
          '</div>' +
          '<div class="home-panel">' +
            '<h3>Roster Progress</h3>' +
            '<p>' + formatHomeNumber(summary.readyCount) + ' of ' + formatHomeNumber(summary.totalCount) + ' imported taxa have ready sprites.</p>' +
            '<div class="home-progress" aria-label="Ready sprite progress"><span style="--progress:' + Math.max(0, Math.min(100, readyPct)) + '%"></span></div>' +
            '<p class="subtle">' + escapeHtml(groupText) + '</p>' +
          '</div>' +
          '<div class="home-panel">' +
            '<h3>Training</h3>' +
            '<p>' + formatHomeNumber(summary.trainingSpent) + ' points spent. ' + formatHomeNumber(summary.affinityTotal) + ' total roster affinity.</p>' +
            '<button class="secondary" type="button" data-home-action="training">Open Training</button>' +
          '</div>' +
          '<div class="home-panel">' +
            '<h3>Sprite Library</h3>' +
            '<p>Browse the shared tree or inspect the newest global sprites added to the game.</p>' +
            '<div class="home-actions">' +
              '<button class="secondary" type="button" data-home-action="recent">Recent</button>' +
              '<button class="secondary" type="button" data-home-action="tree">Sprite Tree</button>' +
            '</div>' +
          '</div>' +
          '<div class="home-panel">' +
            '<h3>Observations</h3>' +
            '<p>' + formatHomeNumber(summary.observationTotal) + ' imported observations across your current roster.</p>' +
            '<button class="secondary" type="button" data-home-action="roster">Open Roster</button>' +
          '</div>' +
        '</section>';
    }

    function renderHomeMetric(label, value, detail) {
      return '<div class="home-metric">' +
        '<span class="subtle">' + escapeHtml(label) + '</span>' +
        '<strong>' + formatHomeNumber(value) + '</strong>' +
        '<span class="subtle">' + escapeHtml(detail) + '</span>' +
      '</div>';
    }

    function renderHomeTeamSlots() {
      const ids = Array.from(state.selectedTaxa);
      const slots = [];
      for (let index = 0; index < 5; index += 1) {
        const taxonId = ids[index];
        const taxon = taxonId ? state.taxa.find((candidate) => String(candidate.taxonId) === String(taxonId)) : null;
        if (!taxonId) {
          slots.push('<div class="home-team-slot empty"><div class="home-slot-index">' + (index + 1) + '</div><div><strong>Open slot</strong><span>Select a ready species</span></div></div>');
        } else if (taxon) {
          slots.push('<div class="home-team-slot">' +
            renderHomeThumb(taxon) +
            '<div><strong>' + escapeHtml(taxon.name || taxon.scientificName || "Selected species") + '</strong><span><em>' + escapeHtml(taxon.scientificName || "") + '</em></span></div>' +
            '<span class="subtle">' + escapeHtml((taxon.types || []).join(" / ")) + '</span>' +
          '</div>');
        } else {
          slots.push('<div class="home-team-slot empty"><div class="home-slot-index">' + (index + 1) + '</div><div><strong>Selected taxon ' + escapeHtml(String(taxonId)) + '</strong><span>Open roster page for details</span></div></div>');
        }
      }
      return '<div class="home-team-slots">' + slots.join("") + '</div>';
    }

    function renderHomeReadyPicks() {
      const picks = state.taxa
        .filter((taxon) => taxon.sprite?.status === "ready" && !state.selectedTaxa.has(String(taxon.taxonId)))
        .slice(0, 5);

      if (!picks.length) {
        return '<p class="subtle">No unselected ready species on this page. Open the ready roster filter to browse more.</p>' +
          '<button class="secondary" type="button" data-home-action="ready-roster">Browse Ready Species</button>';
      }

      return '<div class="home-ready-list">' + picks.map((taxon) => (
        '<button class="home-ready-item" type="button" data-home-add-taxon="' + escapeAttr(String(taxon.taxonId)) + '">' +
          renderHomeThumb(taxon) +
          '<div><strong>' + escapeHtml(taxon.name || taxon.scientificName || "Ready species") + '</strong><span><em>' + escapeHtml(taxon.scientificName || "") + '</em> / ' + Number(taxon.obsCount || 0) + ' obs</span></div>' +
          '<span class="subtle">Add</span>' +
        '</button>'
      )).join("") + '</div>';
    }

    function renderHomeThumb(taxon) {
      if (taxon.sprite?.url) {
        return '<div class="home-ready-thumb">' + renderSheetSprite(taxon.sprite.url, "anim-idle") + '</div>';
      }
      return '<div class="home-ready-thumb">' + escapeHtml((taxon.iconicTaxonName || "Life").slice(0, 1).toUpperCase()) + '</div>';
    }

    function renderOnboardingHome() {
      const me = state.me || {};
      const busyAttr = state.bskyBusy ? " disabled" : "";
      const pendingLogin = me.inatPendingLogin || "";
      const hasCode = Boolean(me.inatPendingLogin && me.inatVerificationCode);

      return '<section class="onboarding-card">' +
        '<div class="onboarding-copy">' +
          '<div class="subtle">Setup</div>' +
          '<h2>Link your field life.</h2>' +
          '<p>' + (me.guest
            ? 'You are playing as a guest. One quick iNaturalist verification connects your real observations to the game roster.'
            : 'You are signed in with Bluesky. One quick iNaturalist verification connects your real observations to the game roster.') + '</p>' +
          '<div class="onboarding-steps">' +
            (me.guest
              ? renderOnboardingStep("1", "Playing as guest", "No Bluesky needed. Connect one later (sidebar) for challenges and buddies.", "complete")
              : renderOnboardingStep("1", "Bluesky connected", "Signed in as @" + (me.handle || "Bluesky"), "complete")) +
            renderOnboardingStep("2", "Choose iNaturalist username", "Enter the public iNaturalist account you want to battle with.", hasCode ? "complete" : "active") +
            renderOnboardingStep("3", "Paste code and verify", "Add the code to your iNaturalist profile bio, verify here, then remove it.", hasCode ? "active" : "") +
          '</div>' +
        '</div>' +
        '<div class="onboarding-form">' +
          '<h3>Verify iNaturalist</h3>' +
          renderBskyStatus() +
          '<label>iNaturalist username' +
            '<input id="homeInatLinkInput" data-inat-link-input="1" data-bsky-enter="inat-start" placeholder="mmulqueen" value="' + escapeAttr(pendingLogin) + '">' +
          '</label>' +
          '<button class="secondary" type="button" data-bsky-action="inat-start"' + busyAttr + '>' +
            (state.bskyBusy && state.bskyAction === "inat-start" ? "Creating code..." : (hasCode ? "Refresh Code" : "Get Verification Code")) +
          '</button>' +
          (hasCode
            ? '<div class="onboarding-code">' +
                '<span class="subtle">Add this code to your iNaturalist profile bio</span>' +
                '<strong>' + escapeHtml(me.inatVerificationCode) + '</strong>' +
                '<span class="subtle">Use iNaturalist settings for "' + escapeHtml(pendingLogin) + '", save, then verify below.</span>' +
              '</div>' +
              '<a class="manual-result-link" href="https://www.inaturalist.org/users/edit" target="_blank" rel="noopener">Open iNaturalist settings</a>' +
              '<button class="primary" type="button" data-bsky-action="inat-confirm"' + busyAttr + '>' +
                (state.bskyBusy && state.bskyAction === "inat-confirm" ? "Verifying..." : "Verify and Import") +
              '</button>'
            : '<p>No iNaturalist password or write access needed. The temporary bio code only proves that the public profile is yours.</p>') +
        '</div>' +
      '</section>';
    }

    function renderOnboardingStep(index, title, body, stateClass) {
      const className = stateClass ? " " + stateClass : "";
      const marker = index;
      return '<div class="onboarding-step' + className + '">' +
        '<div class="onboarding-step-index">' + escapeHtml(marker) + '</div>' +
        '<div><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(body) + '</span></div>' +
      '</div>';
    }

    function render() {
      renderLanding();
      els.accountLabel.textContent = state.inatLogin ? "@" + state.inatLogin : "No roster loaded";

      const hasFilters = Boolean(state.rosterSearch || state.rosterIconic || state.rosterStatus !== "all");
      els.emptyState.style.display = state.taxa.length ? "none" : "grid";
      els.emptyState.textContent = hasFilters
        ? "No roster creatures match these filters."
        : state.viewUserId
          ? "“" + (state.viewLabel || state.viewUserId) + "” isn’t in iNat Battler yet, or has no roster."
          : "Link your iNaturalist account, then import your roster.";
      els.rosterGrid.classList.toggle("sprite-mode", state.rosterMode === "sprites");
      els.rosterModeButton.textContent = state.rosterMode === "sprites" ? "Card View" : "Sprite Grid";
      els.rosterGrid.innerHTML = state.taxa
        .map(state.rosterMode === "sprites" ? renderSpriteTile : renderCard)
        .join("");
      renderTypeChips();
      renderRosterPagination();

      const summary = currentRosterSummary();
      const selectedCount = state.selectedTaxa.size;

      els.taxaCount.textContent = String(summary.totalCount || state.rosterTotal || state.taxa.length);
      els.spriteCount.textContent = String(summary.readyCount);
      els.queuedCount.textContent = String(summary.pendingCount);
      els.bondCount.textContent = String(summary.affinityTotal);
      els.teamCount.textContent = selectedCount + " / 5 selected";
      els.clearTeamButton.disabled = selectedCount === 0;
      els.startBattleButton.disabled = !state.userId || selectedCount !== 5;
      els.refreshLabel.textContent = state.rosterTotal
        ? (state.rosterTotal > ROSTER_PAGE_SIZE
          ? rosterRangeLabel() + " of " + state.rosterTotal
          : String(state.rosterTotal) + " species")
        : "";
      renderViewTabs();
      renderHome();
      renderSpriteTree();
      renderRecentSprites();
      renderBattle();
    }

    function rosterRangeLabel() {
      const start = (state.rosterPage - 1) * ROSTER_PAGE_SIZE + 1;
      const end = Math.min(state.rosterTotal, start + state.taxa.length - 1);
      return start + "–" + end;
    }

    function renderRosterPagination() {
      const pageCount = Math.max(1, Math.ceil(state.rosterTotal / ROSTER_PAGE_SIZE));
      if (state.rosterTotal <= ROSTER_PAGE_SIZE) {
        els.rosterPagination.innerHTML = "";
        return;
      }

      els.rosterPagination.innerHTML =
        '<button class="secondary" type="button" data-roster-page="prev"' +
          (state.rosterPage <= 1 ? " disabled" : "") + '>&larr; Prev</button>' +
        '<span class="subtle">Page ' + state.rosterPage + ' of ' + pageCount +
          ' &middot; ' + state.rosterTotal + ' species</span>' +
        '<button class="secondary" type="button" data-roster-page="next"' +
          (state.rosterPage >= pageCount ? " disabled" : "") + '>Next &rarr;</button>';
    }

    function renderTypeChips() {
      const counts = state.rosterIconicCounts;
      if (!Array.isArray(counts) || counts.length < 2) {
        els.rosterTypeChips.innerHTML = "";
        return;
      }

      els.rosterTypeChips.innerHTML = counts.map((row) =>
        '<button type="button" class="type-chip' + (state.rosterIconic === row.iconic ? " active" : "") +
          '" data-type-chip="' + escapeAttr(row.iconic) + '">' +
          escapeHtml(row.iconic) + ' <span class="subtle">' + Number(row.count) + '</span>' +
        '</button>'
      ).join("");
    }

    function renderSpriteTile(taxon) {
      const status = taxon.sprite.status;
      const isReady = status === "ready";
      const taxonId = String(taxon.taxonId);
      const isSelected = state.selectedTaxa.has(taxonId);
      const imageUrl = isReady ? taxon.sprite.url : taxon.defaultPhotoUrl;
      const image = isReady && imageUrl
        ? renderSheetSprite(imageUrl, "anim-idle")
        : imageUrl
        ? '<img alt="" loading="lazy" src="' + escapeAttr(imageUrl) + '">'
        : '<div class="placeholder-shape placeholder-' + escapeAttr(taxon.sprite.placeholder || "unknown") + '"></div>';

      return '<article class="sprite-tile ' + (isSelected ? "selected " : "") + (!isReady ? "unselectable" : "") +
        '" data-taxon-card data-taxon-id="' + escapeAttr(taxonId) + '" tabindex="0" role="button" aria-pressed="' + String(isSelected) +
        '" aria-label="' + escapeAttr((taxon.nickname || taxon.name || taxon.scientificName || "Taxon") + " combat selection") + '">' +
        '<div class="sprite-tile-art">' + image + '</div>' +
        (!isReady ? '<span class="badge">' + escapeHtml(status) + '</span>' : '') +
        '<div class="select-mark" aria-hidden="true">' + (isSelected ? "OK" : "") + '</div>' +
        '<div class="sprite-tile-caption">' + escapeHtml(taxon.nickname || taxon.name || taxon.scientificName || "") +
          '<span class="subtle">' + escapeHtml(taxon.scientificName || "") + '</span>' +
        '</div>' +
      '</article>';
    }

    // Phase 2: mobile taxonomic navigator. Vertical = depth (breadcrumb trunk +
    // drill down), horizontal swipe = sibling clades at the current rank
    // (scroll-snap carousel). Genus level becomes a gallery of animated sprites.
    function renderSpriteTree() {
      const tree = state.spriteTree;

      if (state.spriteTreeLoading) {
        els.treeRefreshLabel.textContent = "Loading...";
        els.spriteTreePanel.innerHTML = renderTreeLoading();
        return;
      }

      if (state.spriteTreeError && !tree) {
        els.treeRefreshLabel.textContent = "";
        els.spriteTreePanel.innerHTML =
          '<div class="empty">Could not load the sprite tree: ' + escapeHtml(state.spriteTreeError) + '</div>';
        return;
      }

      if (!tree) {
        els.treeRefreshLabel.textContent = "";
        els.spriteTreePanel.innerHTML = '<div class="empty">Open this tab to load the ready sprite tree.</div>';
        return;
      }

      els.treeRefreshLabel.textContent = Number(tree.totalSprites || 0) + " ready sprites";

      if (!Array.isArray(tree.roots) || tree.roots.length === 0) {
        els.spriteTreePanel.innerHTML = '<div class="empty">No ready sprites match this search.</div>';
        return;
      }

      // Search mode: a flat gallery of every matched species (lineage nav off).
      if (String(tree.q || "").trim()) {
        const matched = collectTreeLeaves(tree.roots);
        els.spriteTreePanel.innerHTML =
          '<div class="tree-summary">' + treeSummaryText(tree) + '</div>' +
          (matched.length
            ? renderTreeGallery(matched)
            : '<div class="empty">No ready sprites match this search.</div>');
        return;
      }

      const node = treeNodeByPath(tree.roots, state.treePath);
      const group = treeGroupToken(tree.roots, state.treePath);
      const branches = (node.children || []).filter((c) => !c.leaf);
      const leaves = (node.children || []).filter((c) => c.leaf);

      els.spriteTreePanel.innerHTML =
        '<div class="tree-nav" data-group="' + escapeAttr(group) + '">' +
          renderTreeBreadcrumb(tree.roots, state.treePath) +
          renderTreeFocusHeader(node) +
          (branches.length ? renderTreeCarousel(branches) : "") +
          (leaves.length ? renderTreeGallery(leaves) : "") +
          (!branches.length && !leaves.length ? '<div class="empty">Nothing here yet.</div>' : "") +
        '</div>';
    }

    function renderTreeLoading() {
      return '<div class="tree-loading" role="status" aria-live="polite" aria-busy="true">' +
        '<div class="tree-loading-inner">' +
          '<div class="tree-spinner" aria-hidden="true"></div>' +
          '<div class="tree-loading-title">Loading sprite tree</div>' +
          '<div class="tree-loading-message">' + escapeHtml(state.spriteTreeMessage || TREE_LOADING_MESSAGES[0]) + '</div>' +
        '</div>' +
      '</div>';
    }

    function syncTreePath(tree, query, previousQuery) {
      const roots = Array.isArray(tree?.roots) ? tree.roots : [];
      const root = roots[0];
      if (!root) { state.treePath = []; return; }
      if (String(query || "") !== String(previousQuery || "") || !treePathResolves(roots, state.treePath)) {
        state.treePath = [String(root.key)];
      }
    }

    function treePathResolves(roots, path) {
      if (!Array.isArray(path) || path.length === 0) return false;
      const root = roots[0];
      if (!root || String(path[0]) !== String(root.key)) return false;
      let node = root;
      for (let i = 1; i < path.length; i += 1) {
        const next = (node.children || []).find((c) => !c.leaf && String(c.key) === String(path[i]));
        if (!next) return false;
        node = next;
      }
      return true;
    }

    function treeNodeByPath(roots, path) {
      let node = roots[0];
      for (let i = 1; i < (path || []).length; i += 1) {
        const next = (node.children || []).find((c) => !c.leaf && String(c.key) === String(path[i]));
        if (!next) break;
        node = next;
      }
      return node;
    }

    // Kingdom (path[1]) -> a stable token used for per-group color theming.
    function treeGroupToken(roots, path) {
      if (!Array.isArray(path) || path.length < 2) return "life";
      const kingdom = (roots[0].children || []).find((c) => String(c.key) === String(path[1]));
      const name = String(kingdom?.name || kingdom?.scientificName || "").toLowerCase();
      if (name.includes("animal")) return "animals";
      if (name.includes("plant")) return "plants";
      if (name.includes("fungi")) return "fungi";
      return "other";
    }

    function renderTreeBreadcrumb(roots, path) {
      const crumbs = [];
      let node = roots[0];
      crumbs.push({ name: node.name || "Life", idx: 0 });
      for (let i = 1; i < path.length; i += 1) {
        const next = (node.children || []).find((c) => !c.leaf && String(c.key) === String(path[i]));
        if (!next) break;
        node = next;
        crumbs.push({ name: node.name || "Taxon", idx: i });
      }
      return '<nav class="tree-breadcrumb" aria-label="Lineage">' +
        crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return '<button type="button" class="tree-crumb' + (last ? " current" : "") + '"' +
              ' data-tree-nav="' + c.idx + '"' + (last ? ' aria-current="true"' : "") + '>' +
              escapeHtml(c.name) +
            '</button>' +
            (last ? "" : '<span class="tree-crumb-sep" aria-hidden="true">&rsaquo;</span>');
        }).join("") +
      '</nav>';
    }

    function renderTreeFocusHeader(node) {
      const rank = node.rank && node.rank !== "root" ? node.rank : "life";
      const branchCount = (node.children || []).filter((c) => !c.leaf).length;
      const sub = branchCount
        ? branchCount + " " + childRankPlural(node) + " · " + Number(node.spriteCount || 0) + " sprites"
        : Number(node.spriteCount || 0) + " sprites";
      return '<div class="tree-focus">' +
        '<span class="tree-focus-rank">' + escapeHtml(rank) + '</span>' +
        '<span class="tree-focus-name">' + escapeHtml(node.name || "Life") + '</span>' +
        '<span class="tree-focus-sub">' + escapeHtml(sub) + '</span>' +
      '</div>';
    }

    function childRankPlural(node) {
      const child = (node.children || []).find((c) => !c.leaf);
      const map = {
        kingdom: "kingdoms", phylum: "phyla", class: "classes",
        order: "orders", family: "families", genus: "genera"
      };
      return map[child?.rank] || "groups";
    }

    function renderTreeCarousel(branches) {
      return '<div class="tree-carousel" role="list">' +
        branches.map(renderTreeCard).join("") +
      '</div>';
    }

    function renderTreeCard(branch) {
      const preview = collectTreeLeaves([branch], 1)[0];
      const art = preview && preview.sprite?.url
        ? renderSheetSprite(preview.sprite.url, "anim-idle")
        : '<div class="placeholder-shape placeholder-' + escapeAttr(placeholderFor(branch.iconicTaxonName)) + '"></div>';
      return '<button type="button" class="tree-card" role="listitem" data-tree-descend="' + escapeAttr(String(branch.key)) + '">' +
        '<span class="tree-card-art">' + art + '</span>' +
        '<span class="tree-card-name">' + escapeHtml(branch.name || "Taxon") + '</span>' +
        '<span class="tree-card-meta">' + escapeHtml(branch.rank || "") + ' · ' + Number(branch.spriteCount || 0) + '</span>' +
      '</button>';
    }

    function renderTreeGallery(leaves) {
      return '<div class="tree-gallery" role="list">' +
        leaves.map(renderTreeMedallion).join("") +
      '</div>';
    }

    function renderTreeMedallion(leaf) {
      const art = leaf.sprite?.url
        ? renderSheetSprite(leaf.sprite.url, "anim-idle")
        : '<div class="placeholder-shape placeholder-' + escapeAttr(placeholderFor(leaf.iconicTaxonName)) + '"></div>';
      const title = (leaf.scientificName || "") + " · taxon " + Number(leaf.taxonId || 0);
      return '<a class="tree-medallion" role="listitem" href="' + escapeAttr(leaf.sprite?.url || "#") + '"' +
          ' target="_blank" rel="noreferrer" title="' + escapeAttr(title) + '">' +
        '<span class="tree-medallion-art">' + art + '</span>' +
        '<span class="tree-medallion-name">' + escapeHtml(leaf.name || leaf.scientificName || "Unnamed") + '</span>' +
        '<span class="tree-medallion-sci"><em>' + escapeHtml(leaf.scientificName || "") + '</em></span>' +
      '</a>';
    }

    // Depth-first collection of leaf (species) descendants, optionally capped.
    function collectTreeLeaves(nodes, limit) {
      const out = [];
      const visit = (n) => {
        if (limit && out.length >= limit) return;
        if (n.leaf) { out.push(n); return; }
        for (const child of n.children || []) {
          if (limit && out.length >= limit) break;
          visit(child);
        }
      };
      for (const n of nodes || []) {
        if (limit && out.length >= limit) break;
        visit(n);
      }
      return out;
    }

    function renderRecentSprites() {
      const recent = state.recentSprites;

      if (!recent) {
        els.recentRefreshLabel.textContent = "";
        els.recentSpritesPanel.innerHTML = '<div class="empty">Open this tab to load recently added sprites.</div>';
        return;
      }

      const allSprites = Array.isArray(recent.sprites) ? recent.sprites : [];
      els.recentRefreshLabel.textContent = Number(recent.totalSprites || allSprites.length) + " newest sprites";
      syncRecentGroupFilter(allSprites);

      let sprites = state.recentGroup === "all"
        ? allSprites.slice()
        : allSprites.filter((item) => (item.iconicTaxonName || "Life") === state.recentGroup);

      const createdMs = (item) => {
        const time = new Date(item.sprite?.createdAt || 0).getTime();
        return Number.isNaN(time) ? 0 : time;
      };
      if (state.recentSort === "oldest") sprites.sort((a, b) => createdMs(a) - createdMs(b));
      else if (state.recentSort === "name") {
        sprites.sort((a, b) => String(a.name || a.scientificName || "").localeCompare(String(b.name || b.scientificName || "")));
      } else sprites.sort((a, b) => createdMs(b) - createdMs(a));

      if (sprites.length === 0) {
        els.recentSpritesPanel.innerHTML = '<div class="empty">No ready sprites match this search.</div>';
        return;
      }

      els.recentSpritesPanel.innerHTML =
        '<div class="tree-summary">' + recentSummaryText(recent) + '</div>' +
        '<div class="recent-grid" role="list">' +
          sprites.map(renderRecentSprite).join("") +
        '</div>';
    }

    function syncRecentGroupFilter(sprites) {
      const groups = [...new Set(sprites.map((item) => item.iconicTaxonName || "Life"))].sort();
      if (state.recentGroup !== "all" && !groups.includes(state.recentGroup)) state.recentGroup = "all";

      els.recentGroupFilter.innerHTML =
        '<option value="all">All groups</option>' +
        groups.map((group) =>
          '<option value="' + escapeAttr(group) + '"' + (state.recentGroup === group ? " selected" : "") + '>' +
            escapeHtml(group) +
          '</option>'
        ).join("");
    }

    function recentSummaryText(recent) {
      const q = String(recent.q || "").trim();
      const total = Number(recent.totalSprites || 0);
      if (q) return total + ' newest ready sprites matching "' + escapeHtml(q) + '"';
      return total + " newest ready sprites, newest first";
    }

    function renderRecentSprite(item) {
      const sprite = item.sprite?.url
        ? renderSheetSprite(item.sprite.url, "anim-idle")
        : '<div class="placeholder-shape placeholder-' + escapeAttr(placeholderFor(item.iconicTaxonName)) + '"></div>';
      const createdAt = formatRecentSpriteDate(item.sprite?.createdAt);
      const model = item.sprite?.model || "sprite";
      const dimensions = item.sprite?.width && item.sprite?.height
        ? Number(item.sprite.width) + "x" + Number(item.sprite.height)
        : "";
      const meta = [
        escapeHtml((item.rank || "taxon") + " / " + (item.iconicTaxonName || "Life")),
        "taxon " + Number(item.taxonId || 0),
        escapeHtml(model),
        escapeHtml(dimensions)
      ].filter(Boolean).join(" / ");

      return '<div class="recent-tile" role="listitem">' +
        '<div class="sprite-tile-art">' + sprite + '</div>' +
        '<a class="manual-result-link" href="' + escapeAttr(item.sprite?.url || "#") + '" target="_blank" rel="noreferrer">Open</a>' +
        '<div class="sprite-tile-caption" title="' + escapeAttr(meta) + '">' +
          escapeHtml(item.name || item.scientificName || "Unnamed taxon") +
          '<span class="subtle"><em>' + escapeHtml(item.scientificName || "") + '</em></span>' +
          '<span class="subtle">added ' + escapeHtml(createdAt) + '</span>' +
        '</div>' +
      '</div>';
    }

    function formatRecentSpriteDate(value) {
      if (!value) return "unknown";
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      return date.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit"
      });
    }

    function treeSummaryText(tree) {
      const q = String(tree.q || "").trim();
      const total = Number(tree.totalSprites || 0);
      if (q) return total + ' ready sprites matching "' + escapeHtml(q) + '"';
      return total + " ready sprites by taxonomic branch";
    }

    async function uploadManualSprite() {
      const file = els.manualSpriteFile.files && els.manualSpriteFile.files[0];
      const taxonId = els.manualTaxonId.value.trim();

      if (!file) {
        setStatus("Choose a sprite sheet image first.");
        return;
      }

      if (!/^[0-9]+$/.test(taxonId)) {
        setStatus("Enter a numeric iNaturalist taxon ID.");
        return;
      }

      const formData = new FormData();
      formData.append("taxonId", taxonId);
      formData.append("sprite", file);

      setBusy(true, "Submitting custom sprite");
      els.manualUploadState.textContent = "uploading";

      try {
        const result = await apiFetch("/api/my-sprites/upload", {
          method: "POST",
          body: formData
        });

        els.manualUploadState.textContent = "ready";
        els.manualUploadResult.innerHTML = renderManualUploadResult(result);
        setStatus("Custom sprite submitted for " + (result.name || "taxon " + taxonId) + ". It is live for you while QA is pending.");

        if (state.userId) {
          await loadMySprites();
          await loadRoster();
        }

        if (state.activeView === "tree") {
          await loadSpriteTree(false);
        }
      } catch (error) {
        els.manualUploadState.textContent = "failed";
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    function renderManualUploadResult(result) {
      const size = result.width && result.height
        ? result.width + " x " + result.height
        : "size unknown";

      return '<div class="batch-item">' +
        '<strong>' + escapeHtml(result.name || "Custom sprite") + '</strong>' +
        '<span>taxon ' + Number(result.taxonId || 0) + ' / ' + escapeHtml(size) + ' / ' + escapeHtml(result.status || "pending") + '</span>' +
        (result.discordError ? '<span class="subtle">Discord QA post will retry: ' + escapeHtml(result.discordError) + '</span>' : '<span class="subtle">Submitted for Discord QA; visible to you while pending.</span>') +
        renderUploadMovesSummary(result.moves) +
        '<a class="manual-result-link" href="' + escapeAttr(result.url || "#") + '" target="_blank" rel="noreferrer">Open asset</a>' +
      '</div>';
    }

    function renderUploadMovesSummary(moves) {
      if (!moves) return "";
      if (moves.skipped) {
        return '<span class="subtle">Existing species moves kept.</span>';
      }
      if (!moves.generated) {
        return '<span class="subtle">Moves not generated: ' + escapeHtml(moves.error || "unknown error") + '</span>';
      }
      const names = Array.isArray(moves.signatureMoves) && moves.signatureMoves.length
        ? moves.signatureMoves.join(", ")
        : "signature moves";
      return '<span class="subtle">' +
        (moves.imageConditioned ? "Image-conditioned moves: " : "Moves regenerated: ") +
        escapeHtml(names) +
      '</span>';
    }

    function pruneSelectedTaxa() {
      // With a paginated roster only the current page is loaded, so keep
      // selections for taxa on other pages; drop only loaded-but-not-ready ones.
      const loaded = new Map(state.taxa.map((taxon) => [String(taxon.taxonId), taxon]));

      state.selectedTaxa = new Set(Array.from(state.selectedTaxa).filter((taxonId) => {
        const taxon = loaded.get(String(taxonId));
        return !taxon || (taxon.sprite && taxon.sprite.status === "ready");
      }));
    }

    function toggleTeamSelection(taxonId) {
      const normalized = String(taxonId || "");
      const taxon = state.taxa.find((candidate) => String(candidate.taxonId) === normalized);
      if (!taxon || taxon.sprite.status !== "ready") {
        setStatus("Only ready sprites can join the combat team.");
        return;
      }

      if (state.selectedTaxa.has(normalized)) {
        state.selectedTaxa.delete(normalized);
      } else {
        if (state.selectedTaxa.size >= 5) {
          setStatus("Five creatures are already selected.");
          return;
        }
        state.selectedTaxa.add(normalized);
      }

      render();
    }

    function toggleCardFlip(taxonId) {
      if (!taxonId) return;

      if (state.flippedTaxa.has(taxonId)) {
        state.flippedTaxa.delete(taxonId);
      } else {
        state.flippedTaxa.add(taxonId);
      }

      render();
    }

    async function chooseSpriteVariant(taxonId, direction) {
      if (!state.userId || !taxonId || !direction) return;
      const taxon = state.taxa.find((entry) => String(entry.taxonId) === String(taxonId));
      const variants = Array.isArray(taxon?.sprite?.variants) ? taxon.sprite.variants : [];
      if (!taxon || variants.length < 2) return;

      const currentIndex = Math.max(0, variants.findIndex((variant) => variant.assetId === taxon.sprite.assetId));
      const nextIndex = (currentIndex + direction + variants.length) % variants.length;
      const next = variants[nextIndex];
      if (!next?.assetId) return;

      try {
        const res = await apiFetch(
          "/api/users/" + encodeURIComponent(state.userId) +
            "/sprites/" + encodeURIComponent(String(taxonId)) +
            "/preference",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ assetId: next.assetId })
          }
        );

        taxon.sprite = {
          ...taxon.sprite,
          ...res.sprite,
          placeholder: taxon.sprite.placeholder
        };
        setStatus("Selected " + (res.sprite?.variantIndex + 1 || nextIndex + 1) + " / " + variants.length + " for " + (taxon.name || taxon.scientificName));
        render();
      } catch (error) {
        setStatus(error.message);
      }
    }

    function renderCard(taxon) {
      const status = taxon.sprite.status;
      const isReady = status === "ready";
      const taxonId = String(taxon.taxonId);
      const isFlipped = state.flippedTaxa.has(taxonId);
      const isSelected = state.selectedTaxa.has(taxonId);
      const imageUrl = isReady ? taxon.sprite.url : taxon.defaultPhotoUrl;
      const image = isReady && imageUrl
        ? renderSheetSprite(imageUrl, "anim-idle")
        : imageUrl
        ? '<img alt="" loading="lazy" src="' + escapeAttr(imageUrl) + '">'
        : '<div class="placeholder-shape placeholder-' + escapeAttr(taxon.sprite.placeholder || "unknown") + '"></div>';
      const badge = isReady ? "ready" : status;
      const types = Array.isArray(taxon.types) ? taxon.types.join(" / ") : (taxon.iconicTaxon || "Life");

      // Selection (building your team of 5) is its own corner toggle so the rest
      // of the card is free to flip on click. Only shown on your own roster.
      const selectControl = state.viewUserId
        ? ""
        : '<button class="select-mark" type="button" data-card-select data-taxon-id="' + escapeAttr(taxonId) + '"' +
            (isReady ? "" : " disabled") +
            ' aria-pressed="' + String(isSelected) + '" aria-label="' + (isSelected ? "Remove from team" : "Add to team") + '"' +
            ' title="' + (isSelected ? "In your team — click to remove" : "Add to your team") + '">' +
            (isSelected ? "✓" : "+") +
          '</button>';
      const flipHint = '<span class="card-flip-hint" aria-hidden="true">' + (isFlipped ? "↩ sprite" : "stats ↻") + '</span>';

      return '<article class="card ' + (isFlipped ? "flipped " : "") + (isSelected ? "selected " : "") + (!isReady ? "unselectable" : "") + '" data-taxon-card data-taxon-id="' + escapeAttr(taxonId) + '" tabindex="0" role="button" aria-pressed="' + String(isFlipped) + '" aria-label="' + escapeAttr((taxon.name || taxon.scientificName || "Taxon") + " — click to flip between sprite and stats") + '">' +
        '<div class="card-inner">' +
          '<span class="badge">' + escapeHtml(badge) + '</span>' +
          selectControl +
          '<div class="card-face card-front">' +
            '<div class="sprite ' + (isReady ? "ready" : "") + '">' +
              image +
              renderSpritePicker(taxon) +
            '</div>' +
            '<div class="meta">' +
              '<div class="name">' + escapeHtml(taxon.nickname || taxon.name) +
                (Number(taxon.trainingLevel) > 0 ? ' <span class="lv-chip">Lv ' + Number(taxon.trainingLevel) + '</span>' : '') +
              '</div>' +
              '<div class="sci">' + escapeHtml(taxon.nickname ? taxon.name + " · " + taxon.scientificName : taxon.scientificName) + '</div>' +
              '<div class="chips">' +
                '<span class="chip">' + escapeHtml(types) + '</span>' +
                '<span class="chip">' + escapeHtml(taxon.role || "scout") + '</span>' +
                '<span class="chip">' + Number(taxon.obsCount || 0) + ' obs</span>' +
                '<span class="chip">Affinity ' + Number(affinityLevel(taxon) || 0) + '</span>' +
              '</div>' +
            '</div>' +
            flipHint +
          '</div>' +
          '<div class="card-face card-back">' +
            renderCardBack(taxon, types) +
            flipHint +
          '</div>' +
        '</div>' +
      '</article>';
    }

    function renderSpritePicker(taxon) {
      const variants = Array.isArray(taxon?.sprite?.variants) ? taxon.sprite.variants : [];
      if (taxon?.sprite?.status !== "ready" || variants.length < 2) return "";

      const taxonId = String(taxon.taxonId);
      const index = Math.max(0, Math.min(
        variants.length - 1,
        Number(taxon.sprite.variantIndex ?? variants.findIndex((variant) => variant.assetId === taxon.sprite.assetId) ?? 0)
      ));

      return '<div class="sprite-picker" aria-label="Sprite version">' +
        '<button type="button" data-sprite-shift="-1" data-taxon-id="' + escapeAttr(taxonId) + '" aria-label="Previous sprite version">&lt;</button>' +
        '<span>' + (index + 1) + '/' + variants.length + '</span>' +
        '<button type="button" data-sprite-shift="1" data-taxon-id="' + escapeAttr(taxonId) + '" aria-label="Next sprite version">&gt;</button>' +
      '</div>';
    }

    function renderCardBack(taxon, types) {
      return '<div class="card-back-head">' +
          '<div class="name">' + escapeHtml(taxon.name) + '</div>' +
          '<div class="sci">' + escapeHtml(types + " / " + (taxon.role || "scout")) + '</div>' +
          '<div class="chips">' +
            '<span class="chip">HP ' + Number(taxon.maxHp || 0) + '</span>' +
            '<span class="chip">Affinity ' + Number(affinityLevel(taxon) || 0) + '</span>' +
          '</div>' +
        '</div>' +
        '<div class="stat-bars">' +
          renderStatRow("Vigor", taxon.stats && taxon.stats.vigor) +
          renderStatRow("Strike", taxon.stats && taxon.stats.strike) +
          renderStatRow("Guard", taxon.stats && taxon.stats.guard) +
          renderStatRow("Tempo", taxon.stats && taxon.stats.tempo) +
          renderStatRow("Sense", taxon.stats && taxon.stats.sense) +
        '</div>' +
        '<div class="abilities">' +
          renderMoveRows(taxon.moves) +
        '</div>';
    }

    function renderStatRow(label, rawValue) {
      const value = Number(rawValue || 0);
      const width = Math.max(4, Math.min(100, value));

      return '<div class="stat-row">' +
        '<span>' + escapeHtml(label) + '</span>' +
        '<div class="stat-track"><span class="stat-fill" style="width:' + width + '%"></span></div>' +
        '<span>' + value + '</span>' +
      '</div>';
    }

    function affinityLevel(taxon) {
      return Number(taxon.affinityLevel ?? taxon.bondLevel ?? 0);
    }

    function renderMoveRows(moves) {
      const safeMoves = Array.isArray(moves) ? moves.slice(0, 4) : [];
      if (safeMoves.length === 0) {
        return '<div class="ability"><div><strong>No moves</strong><span>Missing battle data</span></div></div>';
      }

      return safeMoves.map((move) => {
        const power = Number(move.power || 0);
        const score = power > 0 ? power : "ST";

        return '<div class="ability"' + (move.flavor ? ' title="' + escapeAttr(move.flavor) + '"' : "") + '>' +
          '<div>' +
            '<strong>' + (move.signature ? '<span class="sig-star">★</span> ' : "") + escapeHtml(move.name || move.id || "Move") + '</strong>' +
            '<span>' + escapeHtml((move.type || "Life") + " / " + (move.category || "status")) +
              (move.flavor ? '<br>' + escapeHtml(move.flavor) : "") + '</span>' +
          '</div>' +
          '<div class="ability-power">' + escapeHtml(score) + '</div>' +
        '</div>';
      }).join("");
    }

    async function startNpcBattle() {
      if (!state.userId || state.selectedTaxa.size !== 5) {
        setStatus("Select 5 ready sprites first.");
        return;
      }

      const taxonIds = Array.from(state.selectedTaxa).map(Number);
      setBusy(true, "Starting NPC battle");

      try {
        await apiFetch("/api/users/" + encodeURIComponent(state.userId) + "/teams", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "Field Team", taxonIds })
        });

        const battle = await apiFetch("/api/battles/npc/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            userId: state.userId,
            taxonIds,
            npcTemplate: "random_ready",
            difficulty: els.npcDifficultySelect.value || "normal"
          })
        });

        setStatus("NPC battle ready");
        enterBattle(battle);
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    async function startDemoBattle() {
      setBusy(true, "Starting 5v5 test battle");

      try {
        const battle = await apiFetch("/api/battles/demo/start", { method: "POST" });
        setStatus("5v5 test battle ready");
        enterBattle(battle);
      } catch (error) {
        setStatus(error.message);
      } finally {
        setBusy(false);
      }
    }

    function enterBattle(battle, options) {
      state.battle = battle;
      state.battleAnimation = "anim-idle";
      state.battlePhase = battle.status === "active" && !(options && options.skipIntro) ? "intro" : "active";
      switchView("battle");
      renderBattle();

      if (state.battlePhase === "intro") {
        playSfx("start");
        setTimeout(() => {
          if (state.battlePhase === "intro") {
            state.battlePhase = "active";
            renderBattle();
          }
        }, 1150);
      }
    }

    async function submitBattleMove(moveId, switchIndex) {
      const isSwitch = switchIndex !== undefined && switchIndex !== null;
      if (!state.battle || (!moveId && !isSwitch) || state.battleBusy) return;

      const prev = state.battle;
      state.battleBusy = true;
      // Keep the active sprite idle here. playTurnEvents replays the resolved turn
      // and lunges each side in order (faster actor first), so the player and
      // opponent never animate at the same time. Baking the player's attack pose
      // here used to keep it "attacking" through the opponent's strike too.
      state.battleAnimation = "anim-idle";
      playSfx("click");
      renderBattle();

      try {
        const next = await apiFetch("/api/battles/" + encodeURIComponent(prev.battleId) + "/action", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(isSwitch ? { switchIndex } : { moveId })
        });
        await playTurnEvents(prev, next);
        state.battle = next;
        state.battleAnimation = "anim-idle";
      } catch (error) {
        setStatus(error.message);
        state.battleAnimation = "anim-idle";
      } finally {
        state.battleBusy = false;
        renderBattle();
        const finished = state.battle && state.battle.status !== "active";
        if (finished && state.lastResultBattle !== state.battle.battleId) {
          state.lastResultBattle = state.battle.battleId;
          playSfx(state.battle.status === "won" ? "win" : state.battle.status === "lost" ? "lose" : "miss");
        }
      }
    }

    // -- Turn sequencing: replay the resolved turn's log as timed effects ----

    function sideForName(name, prev) {
      const playerActive = getActiveCreature(prev.player).name;
      const opponentActive = getActiveCreature(prev.opponent).name;
      if (name === playerActive && name !== opponentActive) return "player";
      if (name === opponentActive && name !== playerActive) return "opponent";
      if (prev.player.creatures.some((creature) => creature.name === name)) return "player";
      return "opponent";
    }

    function moveCategoryFor(prev, side, moveId) {
      if (!moveId) return "physical";
      const creature = getActiveCreature(side === "player" ? prev.player : prev.opponent);
      const move = (creature.moves || []).find((candidate) => candidate.id === moveId);
      return move ? move.category : "physical";
    }

    function moveAnimClassFor(creature, moveId) {
      const move = (creature.moves || []).find((candidate) => candidate.id === moveId);
      if (move && move.animRow === 4) return "anim-special";
      if (move && move.animRow === 3) return "anim-attack";
      return move && move.category === "special" ? "anim-special" : "anim-attack";
    }

    async function playTurnEvents(prev, next) {
      const events = (next.log || []).filter((entry) => entry.turn === prev.turn);
      const hpState = {
        player: { hp: getActiveCreature(prev.player).hp, max: getActiveCreature(prev.player).maxHp },
        opponent: { hp: getActiveCreature(prev.opponent).hp, max: getActiveCreature(prev.opponent).maxHp }
      };
      let lastTargetSide = "opponent";

      for (const entry of events) {
        appendBattleLogLine(entry);
        const text = entry.text || "";

        const damageMatch = text.match(/^(.+) used (.+) and dealt (\d+) damage\.$/);
        if (damageMatch) {
          const actorSide = sideForName(damageMatch[1], prev);
          const targetSide = actorSide === "player" ? "opponent" : "player";
          const damage = Number(damageMatch[3]);
          const actorCreature = getActiveCreature(actorSide === "player" ? prev.player : prev.opponent);
          const moveId = entry.data && entry.data.moveId;
          const isCrit = Boolean(entry.data && entry.data.crit);
          const category = moveCategoryFor(prev, actorSide, moveId);
          lastTargetSide = targetSide;
          triggerAttackVisual(actorSide, moveAnimClassFor(actorCreature, moveId));
          if (category === "special") playSfx("special");
          await delay(280);
          hitEffect(targetSide, damage, hpState);
          if (isCrit) {
            playSfx("crit");
            spawnFloat(targetSide, "CRIT!", "crit");
          }
          await delay(isCrit ? 780 : 640);
          continue;
        }

        if (text === "A critical hit!") {
          // The crit burst already played alongside the damage line.
          await delay(140);
          continue;
        }

        if (/^It's super effective!$/.test(text)) {
          spawnFloat(lastTargetSide, "SUPER EFFECTIVE!", "word eff-strong");
          await delay(340);
          continue;
        }

        if (/not very effective/.test(text)) {
          spawnFloat(lastTargetSide, "RESISTED", "word eff-weak");
          await delay(300);
          continue;
        }

        const rallyMatch = text.match(/^(.+) is cornered and rallies with wild resolve!$/);
        if (rallyMatch) {
          const side = sideForName(rallyMatch[1], prev);
          playSfx("buff");
          spawnFloat(side, "RALLY!", "heal");
          await delay(560);
          continue;
        }

        const vigorHealMatch = text.match(/^(.+)'s vigor restores (\d+) HP\.$/);
        if (vigorHealMatch) {
          const side = sideForName(vigorHealMatch[1], prev);
          const healed = Number(vigorHealMatch[2]);
          playSfx("heal");
          const target = hpState[side];
          target.hp = Math.min(target.max, target.hp + healed);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "+" + healed, "heal");
          await delay(460);
          continue;
        }

        const vigorDrainMatch = text.match(/^(.+)'s sapped vigor drains (\d+) HP\.$/);
        if (vigorDrainMatch) {
          const side = sideForName(vigorDrainMatch[1], prev);
          const damage = Number(vigorDrainMatch[2]);
          playSfx("status");
          const target = hpState[side];
          target.hp = Math.max(0, target.hp - damage);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "-" + damage, "dmg");
          await delay(460);
          continue;
        }

        const multihitMatch = text.match(/^It struck (\d+) times\.$/);
        if (multihitMatch) {
          playSfx("hit", 0.6);
          await delay(260);
          continue;
        }

        const stunMatch = text.match(/^(.+) is stunned and cannot move\.$/);
        if (stunMatch) {
          playSfx("debuff");
          spawnFloat(sideForName(stunMatch[1], prev), "STUNNED!", "word status-fx");
          await delay(520);
          continue;
        }

        const poisonMatch = text.match(/^(.+) is hurt by poison and loses (\d+) HP\.$/);
        if (poisonMatch) {
          const side = sideForName(poisonMatch[1], prev);
          const damage = Number(poisonMatch[2]);
          playSfx("status");
          const target = hpState[side];
          target.hp = Math.max(0, target.hp - damage);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "-" + damage, "dmg");
          await delay(520);
          continue;
        }

        const drainMatch = text.match(/^(.+) drained (\d+) HP\.$/);
        if (drainMatch) {
          const side = sideForName(drainMatch[1], prev);
          const healed = Number(drainMatch[2]);
          playSfx("heal");
          const target = hpState[side];
          target.hp = Math.min(target.max, target.hp + healed);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "+" + healed, "heal");
          await delay(480);
          continue;
        }

        const recoilMatch = text.match(/^(.+) took (\d+) recoil damage\.$/);
        if (recoilMatch) {
          const side = sideForName(recoilMatch[1], prev);
          const damage = Number(recoilMatch[2]);
          playSfx("hit", 0.5);
          const target = hpState[side];
          target.hp = Math.max(0, target.hp - damage);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "-" + damage, "dmg");
          await delay(480);
          continue;
        }

        const blockedMatch = text.match(/^(.+)'s shield softened the blow\.$/);
        if (blockedMatch) {
          playSfx("buff");
          spawnFloat(sideForName(blockedMatch[1], prev), "BLOCKED", "word buff");
          await delay(380);
          continue;
        }

        const appliedMatch =
          text.match(/^(.+) was (poisoned)\.$/) ||
          text.match(/^(.+) is (marked) for the hunt\.$/) ||
          text.match(/^(.+) is (stunned)\.$/) ||
          text.match(/^(.+) (raised a shield)\.$/);
        if (appliedMatch) {
          const side = sideForName(appliedMatch[1], prev);
          const label = appliedMatch[2] === "raised a shield" ? "SHIELDED" : appliedMatch[2].toUpperCase();
          playSfx(appliedMatch[2] === "raised a shield" ? "buff" : "status");
          spawnFloat(side, label, "word status-fx");
          await delay(420);
          continue;
        }

        if (/ shook off the poison\.$/.test(text)) {
          const curedMatch = text.match(/^(.+) shook off the poison\.$/);
          playSfx("heal");
          if (curedMatch) spawnFloat(sideForName(curedMatch[1], prev), "CURED", "word heal");
          await delay(360);
          continue;
        }

        const missMatch = text.match(/^(.+) used (.+), but it missed\.$/);
        if (missMatch) {
          const actorSide = sideForName(missMatch[1], prev);
          triggerAttackVisual(actorSide, "anim-attack");
          await delay(240);
          playSfx("miss");
          spawnFloat(actorSide === "player" ? "opponent" : "player", "MISS", "word miss");
          await delay(420);
          continue;
        }

        const faintMatch = text.match(/^(.+) fainted\.$/);
        if (faintMatch) {
          const side = sideForName(faintMatch[1], prev);
          playSfx("faint");
          faintEffect(side);
          await delay(720);
          continue;
        }

        const healMatch = text.match(/^(.+) recovered (\d+) HP\.$/);
        if (healMatch) {
          const side = sideForName(healMatch[1], prev);
          playSfx("heal");
          const healed = Number(healMatch[2]);
          const target = hpState[side];
          target.hp = Math.min(target.max, target.hp + healed);
          setHpBar(side, target.hp, target.max);
          spawnFloat(side, "+" + healed, "heal");
          await delay(520);
          continue;
        }

        const roseMatch = text.match(/^(.+)'s (vigor|strike|guard|tempo|sense) rose\.$/);
        if (roseMatch) {
          playSfx("buff");
          spawnFloat(sideForName(roseMatch[1], prev), roseMatch[2].toUpperCase() + " ▲", "word buff");
          await delay(420);
          continue;
        }
        const fellMatch = text.match(/^(.+)'s (vigor|strike|guard|tempo|sense) fell\.$/);
        if (fellMatch) {
          playSfx("debuff");
          spawnFloat(sideForName(fellMatch[1], prev), fellMatch[2].toUpperCase() + " ▼", "word debuff");
          await delay(420);
          continue;
        }
        if (/ rose\.$/.test(text)) {
          playSfx("buff");
          await delay(380);
          continue;
        }
        if (/ fell\.$/.test(text)) {
          playSfx("debuff");
          await delay(380);
          continue;
        }
        if (/ became /.test(text)) {
          playSfx("status");
          await delay(380);
          continue;
        }

        const statusMoveMatch = text.match(/^(.+) used (.+)\.$/);
        if (statusMoveMatch) {
          triggerAttackVisual(sideForName(statusMoveMatch[1], prev), "anim-special", "brace");
          playSfx("status");
          await delay(420);
          continue;
        }

        await delay(300);
      }
    }

    function spriteEl(side) {
      return els.battlePanel.querySelector(
        '[data-sprite-zone="' + side + '"] .sheet-sprite, [data-sprite-zone="' + side + '"] .dummy-sprite'
      );
    }

    function triggerAttackVisual(side, animClass, mode) {
      const el = spriteEl(side);
      if (!el) return;

      // Player sits bottom-left, opponent top-right. Attacks lunge toward
      // the foe; defensive/status moves brace with a small back-step hop.
      // Distance and arc height jitter so no two moves trace the same path.
      const dir = side === "player" ? 1 : -1;
      const jitter = (range) => (Math.random() * 2 - 1) * range;
      if (mode === "brace") {
        el.style.setProperty("--lunge-x", Math.round(-dir * (14 + jitter(6))) + "px");
        el.style.setProperty("--lunge-y", Math.round(-(5 + Math.random() * 7)) + "px");
        el.style.setProperty("--arc-h", Math.round(3 + Math.random() * 7) + "px");
      } else {
        el.style.setProperty("--lunge-x", Math.round(dir * (44 + jitter(14))) + "px");
        el.style.setProperty("--lunge-y", Math.round(-dir * (24 + jitter(10))) + "px");
        el.style.setProperty("--arc-h", Math.round(12 + Math.random() * 24) + "px");
      }

      const isSheet = el.classList.contains("sheet-sprite");
      el.classList.remove("anim-idle", "anim-attack", "anim-special", "lunge");
      void el.offsetWidth;
      el.classList.add("lunge");
      if (isSheet) el.classList.add(animClass);
      setTimeout(() => {
        el.classList.remove("anim-attack", "anim-special", "lunge");
        if (isSheet) el.classList.add("anim-idle");
      }, 620);
    }

    function hitEffect(targetSide, damage, hpState) {
      playSfx("hit", Math.min(1.7, 0.7 + damage / 50));

      const el = spriteEl(targetSide);
      if (el) {
        // Knocked away from the attacker, harder for bigger hits, with a
        // little vertical jitter so each recoil reads differently.
        const dir = targetSide === "player" ? -1 : 1;
        const force = Math.min(1.6, 0.8 + damage / 40);
        el.style.setProperty("--kb-x", Math.round(dir * (10 + Math.random() * 8) * force) + "px");
        el.style.setProperty("--kb-y", Math.round(-dir * (3 + Math.random() * 7) * force) + "px");
        el.classList.remove("hit-flash");
        void el.offsetWidth;
        el.classList.add("hit-flash");
        setTimeout(() => el.classList.remove("hit-flash"), 460);
      }

      const stage = document.getElementById("battleStage");
      if (stage) {
        stage.classList.remove("shake");
        void stage.offsetWidth;
        stage.classList.add("shake");
        setTimeout(() => stage.classList.remove("shake"), 360);

        if (targetSide === "player") {
          const flash = document.createElement("div");
          flash.className = "stage-hurt-flash";
          stage.appendChild(flash);
          setTimeout(() => flash.remove(), 420);
        }
      }

      const target = hpState[targetSide];
      spawnFloat(targetSide, "-" + damage, damage >= target.max * 0.22 ? "big" : "");
      target.hp = Math.max(0, target.hp - damage);
      setHpBar(targetSide, target.hp, target.max);
    }

    function setHpBar(side, hp, max) {
      const bar = els.battlePanel.querySelector('[data-hp-bar="' + side + '"]');
      const label = els.battlePanel.querySelector('[data-hp-text="' + side + '"]');
      const pct = max ? Math.max(0, Math.round((hp / max) * 100)) : 0;
      if (bar) {
        bar.style.setProperty("--hp", pct + "%");
        bar.classList.toggle("hp-low", pct <= 25);
      }
      if (label) label.textContent = Math.round(hp) + " / " + Math.round(max) + " HP";
    }

    function spawnFloat(side, text, kind) {
      const zone = els.battlePanel.querySelector('[data-sprite-zone="' + side + '"]');
      if (!zone) return;
      const el = document.createElement("div");
      el.className = "dmg-float" + (kind ? " " + kind : "");
      el.textContent = text;
      // Stack concurrent floats upward so simultaneous events stay readable.
      const live = zone.querySelectorAll(".dmg-float").length;
      if (live > 0) el.style.top = "calc(26% - " + Math.min(3, live) * 24 + "px)";
      zone.appendChild(el);
      setTimeout(() => el.remove(), kind === "crit" ? 1000 : 950);
    }

    function faintEffect(side) {
      const el = spriteEl(side);
      if (el) el.classList.add("fainted");
    }

    function appendBattleLogLine(entry) {
      const panel = document.getElementById("battleLogPanel");
      if (!panel) return;
      const line = document.createElement("div");
      line.textContent = "Turn " + Number(entry.turn || 0) + ": " + (entry.text || "");
      panel.insertBefore(line, panel.firstChild);
    }

    // -- Bluesky presence buddy list (AIM-style) ----------------------------
    //
    // Presence is inferred behaviorally from the Jetstream firehose filtered to
    // only your mutuals' DIDs, never queried:
    //   online  (green)  -> posted / replied / reposted within the window
    //   idle    (yellow) -> only liked / followed within the window (lurking)
    //   offline (gray)   -> quiet; "last seen" backfilled from getLatestCommit
    //
    // Everything here is client-side against the public, CORS-enabled AppView
    // and Jetstream; no auth and no server round-trips.

    const BSKY_APPVIEW = "https://public.api.bsky.app";
    // Public Jetstream instances are region-scoped; the bare host does not
    // resolve. Rotate across them so one instance being down self-heals.
    const JETSTREAM_HOSTS = [
      "jetstream2.us-east.bsky.network",
      "jetstream1.us-east.bsky.network",
      "jetstream2.us-west.bsky.network",
      "jetstream1.us-west.bsky.network"
    ];
    let jetstreamHostIndex = 0;
    const PRESENCE_ONLINE_MS = 10 * 60 * 1000;
    const PRESENCE_IDLE_MS = 10 * 60 * 1000;
    const PRESENCE_GRAPH_PAGE_CAP = 25; // up to ~2500 follows/followers each
    const PRESENCE_BACKFILL_CAP = 40; // lazy "last seen" lookups per session
    const TID_ALPHABET = "234567abcdefghijklmnopqrstuvwxyz";

    function presenceFetchJson(url) {
      return fetch(url, { headers: { accept: "application/json" } }).then((res) => {
        if (!res.ok) throw new Error("Bluesky request failed (" + res.status + ")");
        return res.json();
      });
    }

    async function fetchGraphDids(nsid, actor) {
      const dids = new Map();
      let cursor = "";
      for (let page = 0; page < PRESENCE_GRAPH_PAGE_CAP; page += 1) {
        const url = BSKY_APPVIEW + "/xrpc/" + nsid + "?actor=" + encodeURIComponent(actor) +
          "&limit=100" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
        const data = await presenceFetchJson(url);
        const list = data[nsid.endsWith("getFollows") ? "follows" : "followers"] || [];
        for (const actorObj of list) {
          if (actorObj && actorObj.did) {
            dids.set(actorObj.did, {
              did: actorObj.did,
              handle: actorObj.handle || actorObj.did,
              displayName: actorObj.displayName || "",
              avatar: actorObj.avatar || ""
            });
          }
        }
        cursor = data.cursor || "";
        if (!cursor || list.length === 0) break;
      }
      return dids;
    }

    async function resolveMutuals(did) {
      const [follows, followers] = await Promise.all([
        fetchGraphDids("app.bsky.graph.getFollows", did),
        fetchGraphDids("app.bsky.graph.getFollowers", did)
      ]);
      const mutuals = [];
      for (const [otherDid, profile] of follows) {
        if (followers.has(otherDid)) mutuals.push(profile);
      }
      return mutuals;
    }

    function tidToMs(tid) {
      if (typeof tid !== "string" || tid.length < 10) return 0;
      let n = 0n;
      for (const char of tid) {
        const index = TID_ALPHABET.indexOf(char);
        if (index < 0) return 0;
        n = n * 32n + BigInt(index);
      }
      return Number((n >> 10n) / 1000n);
    }

    function presenceStateFor(buddy, now) {
      if (buddy.lastPostMs && now - buddy.lastPostMs <= PRESENCE_ONLINE_MS) return "online";
      if (buddy.lastLurkMs && now - buddy.lastLurkMs <= PRESENCE_IDLE_MS) return "idle";
      return "offline";
    }

    function presenceRank(stateName) {
      if (stateName === "online") return 0;
      if (stateName === "idle") return 1;
      return 2;
    }

    function relativeTime(ms) {
      if (!ms) return "";
      const diff = Date.now() - ms;
      if (diff < 60 * 1000) return "just now";
      if (diff < 60 * 60 * 1000) return Math.floor(diff / 60000) + "m ago";
      if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / 3600000) + "h ago";
      return Math.floor(diff / 86400000) + "d ago";
    }

    function startPresence(force) {
      const me = state.me;
      if (!me || !me.loggedIn || !me.did || me.guest) {
        els.buddiesPanel.innerHTML = me && me.guest
          ? '<p class="subtle">Buddies are your Bluesky mutuals — connect a Bluesky account (sidebar) to see who’s online.</p>'
          : '<p class="subtle">Sign in with Bluesky to see which of your mutuals are online.</p>';
        els.buddiesMetaLabel.textContent = "";
        return;
      }
      if (state.presence.started && !force) {
        renderBuddies();
        return;
      }
      stopPresence();
      state.presence.started = true;
      state.presence.status = "connecting";
      state.presence.buddies = new Map();
      state.presence.settleAt = 0;
      els.buddiesPanel.innerHTML = '<p class="subtle">Resolving your mutuals from the Bluesky AppView…</p>';
      els.buddiesMetaLabel.textContent = "Connecting";

      resolveMutuals(me.did).then((mutuals) => {
        if (!state.presence.started) return;
        for (const profile of mutuals) {
          state.presence.buddies.set(profile.did, Object.assign({
            lastPostMs: 0,
            lastLurkMs: 0,
            lastSeenMs: 0
          }, profile));
        }
        if (mutuals.length === 0) {
          els.buddiesPanel.innerHTML = '<p class="subtle">No mutuals found yet. Follow some folks back on Bluesky and refresh.</p>';
          els.buddiesMetaLabel.textContent = "0 mutuals";
          return;
        }
        // Suppress the online chime for the first few seconds while the
        // backlog of recent events streams in and seeds initial state.
        state.presence.settleAt = Date.now() + 6000;
        openJetstream(mutuals.map((m) => m.did));
        renderBuddies();
        scheduleBackfill();
      }).catch((error) => {
        state.presence.status = "error";
        els.buddiesPanel.innerHTML = '<p class="subtle">Could not load your mutuals: ' + escapeHtml(error.message) + '</p>';
        els.buddiesMetaLabel.textContent = "Error";
      });
    }

    function stopPresence() {
      const p = state.presence;
      if (p.ws) {
        try { p.ws.onclose = null; p.ws.close(); } catch (error) { /* ignore */ }
        p.ws = null;
      }
      if (p.reconnectTimer) { clearTimeout(p.reconnectTimer); p.reconnectTimer = null; }
      if (p.decayTimer) { clearInterval(p.decayTimer); p.decayTimer = null; }
      p.started = false;
      p.status = "idle";
    }

    function openJetstream(dids) {
      const p = state.presence;
      const host = JETSTREAM_HOSTS[jetstreamHostIndex % JETSTREAM_HOSTS.length];
      // Replay the last window so presence is seeded immediately instead of
      // only filling in as mutuals happen to act while the tab is open.
      const cursorUs = (Date.now() - PRESENCE_ONLINE_MS) * 1000;
      const url = "wss://" + host + "/subscribe?requireHello=true&cursor=" + cursorUs;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch (error) {
        p.status = "error";
        return;
      }
      p.ws = ws;

      ws.onopen = () => {
        p.status = "live";
        // wantedDids MUST be sent as a hello message, not in the URL: hundreds
        // of DIDs as query params blow past the WS handshake URL-length limit
        // and the server refuses the connection.
        ws.send(JSON.stringify({
          type: "options_update",
          payload: {
            wantedCollections: [
              "app.bsky.feed.post",
              "app.bsky.feed.repost",
              "app.bsky.feed.like",
              "app.bsky.graph.follow"
            ],
            wantedDids: dids
          }
        }));
        renderBuddies();
      };

      ws.onmessage = (event) => {
        let msg;
        try { msg = JSON.parse(event.data); } catch (error) { return; }
        handleJetstreamEvent(msg);
      };

      ws.onclose = () => {
        if (!p.started || p.ws !== ws) return;
        p.status = "reconnecting";
        jetstreamHostIndex += 1;
        renderBuddies();
        p.reconnectTimer = setTimeout(() => {
          if (p.started) openJetstream(dids);
        }, 4000);
      };

      ws.onerror = () => {
        try { ws.close(); } catch (error) { /* ignore */ }
      };

      if (!p.decayTimer) {
        p.decayTimer = setInterval(() => renderBuddies(), 30000);
      }
    }

    function handleJetstreamEvent(msg) {
      if (!msg || msg.kind !== "commit" || !msg.commit) return;
      const buddy = state.presence.buddies.get(msg.did);
      if (!buddy) return;
      const op = msg.commit.operation;
      if (op !== "create") return;

      const collection = msg.commit.collection;
      const tsMs = msg.time_us ? Math.floor(msg.time_us / 1000) : Date.now();
      const isPost = collection === "app.bsky.feed.post" || collection === "app.bsky.feed.repost";
      const isLurk = collection === "app.bsky.feed.like" || collection === "app.bsky.graph.follow";
      if (!isPost && !isLurk) return;

      const wasOnline = presenceStateFor(buddy, Date.now()) === "online";
      if (isPost && tsMs > buddy.lastPostMs) buddy.lastPostMs = tsMs;
      if (tsMs > buddy.lastLurkMs) buddy.lastLurkMs = tsMs;
      if (tsMs > buddy.lastSeenMs) buddy.lastSeenMs = tsMs;

      const nowOnline = presenceStateFor(buddy, Date.now()) === "online";
      if (isPost && nowOnline && !wasOnline && Date.now() > state.presence.settleAt) {
        playSfx("buddy");
      }
      queueBuddiesRender();
    }

    function queueBuddiesRender() {
      if (state.presence.renderTimer) return;
      state.presence.renderTimer = setTimeout(() => {
        state.presence.renderTimer = null;
        renderBuddies();
      }, 400);
    }

    function scheduleBackfill() {
      const p = state.presence;
      if (p.backfillStarted) return;
      p.backfillStarted = true;
      const offline = [...p.buddies.values()].filter((b) => !b.lastSeenMs).slice(0, PRESENCE_BACKFILL_CAP);
      let index = 0;
      const step = () => {
        if (!p.started || index >= offline.length) return;
        const buddy = offline[index];
        index += 1;
        backfillLastSeen(buddy).finally(() => setTimeout(step, 250));
      };
      step();
    }

    async function backfillLastSeen(buddy) {
      try {
        const doc = await presenceFetchJson("https://plc.directory/" + encodeURIComponent(buddy.did));
        const services = Array.isArray(doc.service) ? doc.service : [];
        const pds = services.find((s) => s && (s.type === "AtprotoPersonalDataServer" || String(s.id || "").endsWith("#atproto_pds")));
        let endpoint = pds && pds.serviceEndpoint;
        if (!endpoint) return;
        if (endpoint.endsWith("/")) endpoint = endpoint.slice(0, -1);
        const data = await presenceFetchJson(endpoint +
          "/xrpc/com.atproto.sync.getLatestCommit?did=" + encodeURIComponent(buddy.did));
        const ms = tidToMs(data.rev);
        if (ms && ms > buddy.lastSeenMs) {
          buddy.lastSeenMs = ms;
          queueBuddiesRender();
        }
      } catch (error) {
        // Best effort; offline buddies just show no "last seen".
      }
    }

    function renderBuddies() {
      if (!state.presence.started) return;
      const now = Date.now();
      const buddies = [...state.presence.buddies.values()].map((buddy) => {
        return { buddy, stateName: presenceStateFor(buddy, now) };
      });
      buddies.sort((a, b) => {
        const rank = presenceRank(a.stateName) - presenceRank(b.stateName);
        if (rank !== 0) return rank;
        const an = (a.buddy.displayName || a.buddy.handle).toLowerCase();
        const bn = (b.buddy.displayName || b.buddy.handle).toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      });

      const counts = { online: 0, idle: 0, offline: 0 };
      for (const item of buddies) counts[item.stateName] += 1;

      const statusLabel = state.presence.status === "live" ? "live"
        : state.presence.status === "reconnecting" ? "reconnecting…"
        : state.presence.status === "connecting" ? "connecting…"
        : state.presence.status;
      els.buddiesMetaLabel.textContent = counts.online + " online · " + counts.idle + " lurking · " +
        buddies.length + " mutuals · firehose " + statusLabel;

      if (buddies.length === 0) {
        els.buddiesPanel.innerHTML = '<p class="subtle">No mutuals to show.</p>';
        return;
      }

      let html = '<ul class="buddy-list">';
      let lastGroup = "";
      const groupTitles = { online: "Active", idle: "Lurking", offline: "Offline" };
      for (const item of buddies) {
        if (item.stateName !== lastGroup) {
          lastGroup = item.stateName;
          html += '<li class="buddy-group">' + groupTitles[lastGroup] + '</li>';
        }
        html += renderBuddyRow(item.buddy, item.stateName);
      }
      html += '</ul>';
      els.buddiesPanel.innerHTML = html;
    }

    function renderBuddyRow(buddy, stateName) {
      const name = buddy.displayName || buddy.handle;
      const avatar = buddy.avatar
        ? '<img class="buddy-avatar" src="' + escapeAttr(buddy.avatar) + '" alt="" loading="lazy">'
        : '<span class="buddy-avatar buddy-avatar-blank"></span>';
      let sub = "@" + buddy.handle;
      if (stateName === "online") {
        sub = "active · " + relativeTime(buddy.lastPostMs);
      } else if (stateName === "idle") {
        sub = "lurking · " + relativeTime(buddy.lastLurkMs);
      } else if (buddy.lastSeenMs) {
        sub = "last seen " + relativeTime(buddy.lastSeenMs);
      }
      const canChallenge = stateName !== "offline";
      const profileUrl = "https://bsky.app/profile/" + encodeURIComponent(buddy.handle);
      return '<li class="buddy-row ' + stateName + '">' +
        '<span class="buddy-dot ' + stateName + '"></span>' +
        avatar +
        '<span class="buddy-meta">' +
          '<span class="buddy-name">' + escapeHtml(name) + '</span>' +
          '<span class="buddy-sub">' + escapeHtml(sub) + '</span>' +
        '</span>' +
        '<span class="buddy-actions">' +
          (canChallenge
            ? '<button class="secondary buddy-challenge" type="button" data-buddy-challenge="' + escapeAttr(buddy.handle) + '" data-buddy-did="' + escapeAttr(buddy.did) + '">Challenge</button>'
            : '') +
          '<a class="buddy-profile" href="' + escapeAttr(profileUrl) + '" target="_blank" rel="noopener">Profile</a>' +
        '</span>' +
      '</li>';
    }

    function onBuddiesPanelClick(event) {
      const button = event.target.closest("[data-buddy-challenge]");
      if (!button) return;
      const handle = button.getAttribute("data-buddy-challenge");
      if (!handle) return;
      playSfx("click");
      challengeBuddyByHandle(handle);
    }

    async function challengeBuddyByHandle(handle) {
      // Hand off to the existing Battle-tab challenge flow with the opponent
      // handle prefilled, so the rest of the challenge machinery is reused.
      await switchView("battle");
      const handleInput = document.getElementById("challengeHandleInput");
      if (handleInput) {
        handleInput.value = handle;
        handleInput.focus();
        handleInput.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      setStatus("Pick 5 ready sprites, then send your challenge to @" + handle + ".");
    }

    // -- Retro sound effects (WebAudio, fully synthesized, no assets) -------

    let audioCtx = null;
    let audioNoiseBuffer = null;

    function ensureAudio() {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === "suspended") audioCtx.resume();
      return audioCtx;
    }

    // Mobile browsers (iOS Safari especially) start the AudioContext suspended
    // and only let it resume — and on iOS, only "unlock" — inside a real user
    // gesture, with a buffer actually played during that gesture. Prime it on
    // the first touch/click anywhere so later async-fired SFX can play.
    function unlockAudio() {
      try {
        const ctx = ensureAudio();
        const source = ctx.createBufferSource();
        source.buffer = ctx.createBuffer(1, 1, 22050);
        source.connect(ctx.destination);
        source.start(0);
        const cleanup = () => {
          if (ctx.state === "running") {
            document.removeEventListener("pointerdown", unlockAudio);
            document.removeEventListener("touchend", unlockAudio);
            document.removeEventListener("click", unlockAudio);
          }
        };
        if (ctx.state === "suspended") ctx.resume().then(cleanup, () => {}); else cleanup();
      } catch (error) {
        // Audio is best-effort; never break interaction over it.
      }
    }

    document.addEventListener("pointerdown", unlockAudio, { passive: true });
    document.addEventListener("touchend", unlockAudio, { passive: true });
    document.addEventListener("click", unlockAudio, { passive: true });

    function sfxTone(ctx, out, opts) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const t0 = ctx.currentTime + (opts.delay || 0);
      const dur = opts.dur || 0.12;
      osc.type = opts.type || "square";
      osc.frequency.setValueAtTime(Math.max(20, opts.from), t0);
      if (opts.to) osc.frequency.exponentialRampToValueAtTime(Math.max(20, opts.to), t0 + dur);
      gain.gain.setValueAtTime(opts.gain || 0.18, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      osc.connect(gain);
      gain.connect(out);
      osc.start(t0);
      osc.stop(t0 + dur + 0.03);
    }

    function sfxNoise(ctx, out, opts) {
      if (!audioNoiseBuffer) {
        audioNoiseBuffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 0.3), ctx.sampleRate);
        const data = audioNoiseBuffer.getChannelData(0);
        for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
      }
      const source = ctx.createBufferSource();
      source.buffer = audioNoiseBuffer;
      const filter = ctx.createBiquadFilter();
      filter.type = "bandpass";
      filter.frequency.value = opts.freq || 700;
      filter.Q.value = 0.8;
      const gain = ctx.createGain();
      const t0 = ctx.currentTime + (opts.delay || 0);
      const dur = opts.dur || 0.1;
      gain.gain.setValueAtTime(opts.gain || 0.25, t0);
      gain.gain.exponentialRampToValueAtTime(0.0008, t0 + dur);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(out);
      source.start(t0);
      source.stop(t0 + dur + 0.03);
    }

    function playSfx(name, intensity) {
      if (!state.soundOn) return;
      const k = intensity || 1;

      try {
        const ctx = ensureAudio();
        const out = ctx.createGain();
        out.gain.value = 0.5;
        out.connect(ctx.destination);

        if (name === "click") {
          sfxTone(ctx, out, { type: "square", from: 620, to: 740, dur: 0.05, gain: 0.07 });
        } else if (name === "hit") {
          sfxNoise(ctx, out, { freq: 600, dur: 0.09, gain: 0.22 * k });
          sfxTone(ctx, out, { type: "square", from: 190, to: 65, dur: 0.13, gain: 0.2 * k });
        } else if (name === "special") {
          sfxTone(ctx, out, { type: "sawtooth", from: 330, dur: 0.09, gain: 0.1 });
          sfxTone(ctx, out, { type: "sawtooth", from: 440, dur: 0.09, gain: 0.1, delay: 0.07 });
          sfxTone(ctx, out, { type: "sawtooth", from: 587, dur: 0.12, gain: 0.1, delay: 0.14 });
        } else if (name === "crit") {
          sfxNoise(ctx, out, { freq: 950, dur: 0.12, gain: 0.3 });
          sfxTone(ctx, out, { type: "square", from: 260, to: 48, dur: 0.2, gain: 0.24 });
          sfxTone(ctx, out, { type: "square", from: 880, to: 1320, dur: 0.09, gain: 0.12, delay: 0.02 });
        } else if (name === "miss") {
          sfxTone(ctx, out, { type: "triangle", from: 520, to: 170, dur: 0.18, gain: 0.08 });
        } else if (name === "heal") {
          sfxTone(ctx, out, { type: "sine", from: 520, dur: 0.1, gain: 0.12 });
          sfxTone(ctx, out, { type: "sine", from: 780, dur: 0.14, gain: 0.12, delay: 0.09 });
        } else if (name === "buff") {
          sfxTone(ctx, out, { type: "sine", from: 440, to: 660, dur: 0.12, gain: 0.1 });
        } else if (name === "debuff") {
          sfxTone(ctx, out, { type: "sine", from: 440, to: 250, dur: 0.14, gain: 0.1 });
        } else if (name === "status") {
          sfxTone(ctx, out, { type: "triangle", from: 350, dur: 0.1, gain: 0.09 });
        } else if (name === "faint") {
          sfxTone(ctx, out, { type: "square", from: 280, to: 42, dur: 0.45, gain: 0.16 });
        } else if (name === "buddy") {
          // AIM-style "door open" two-note rising chime.
          sfxTone(ctx, out, { type: "sine", from: 660, dur: 0.1, gain: 0.12 });
          sfxTone(ctx, out, { type: "sine", from: 988, dur: 0.16, gain: 0.12, delay: 0.09 });
        } else if (name === "start") {
          sfxTone(ctx, out, { type: "square", from: 392, dur: 0.11, gain: 0.12 });
          sfxTone(ctx, out, { type: "square", from: 523, dur: 0.16, gain: 0.12, delay: 0.11 });
        } else if (name === "win") {
          sfxTone(ctx, out, { type: "square", from: 523, dur: 0.13, gain: 0.12 });
          sfxTone(ctx, out, { type: "square", from: 659, dur: 0.13, gain: 0.12, delay: 0.12 });
          sfxTone(ctx, out, { type: "square", from: 784, dur: 0.13, gain: 0.12, delay: 0.24 });
          sfxTone(ctx, out, { type: "square", from: 1047, dur: 0.3, gain: 0.13, delay: 0.36 });
        } else if (name === "lose") {
          sfxTone(ctx, out, { type: "square", from: 220, to: 180, dur: 0.28, gain: 0.13 });
          sfxTone(ctx, out, { type: "square", from: 165, to: 105, dur: 0.45, gain: 0.13, delay: 0.28 });
        }
      } catch (error) {
        // Audio is best-effort; never break the battle over it.
      }
    }

    // -- Procedural pixel-art battle backdrops ------------------------------

    const BATTLE_BIOMES = {
      meadow: { key: "meadow", sky: ["#9fd4e8", "#b5e0ec", "#cdeaf0"], sun: "#f7d978", cloud: "#f4f9f7", hill: "#6fa06b", ground: "#8fbf6f", groundEdge: "#7aae61", groundDark: "#79a85c", groundLight: "#a3cd82", accent: "#e0788a" },
      wetland: { key: "wetland", sky: ["#a3c8d8", "#b9d8e0", "#cfe6e6"], sun: "#f2e2a0", cloud: "#eef6f4", hill: "#5d8a72", ground: "#6fa384", groundEdge: "#5d927a", groundDark: "#54806a", groundLight: "#8cb89c", accent: "#4f7f9d" },
      forest: { key: "forest", sky: ["#7fae9a", "#92bda4", "#a8ccae"], sun: "#e8e3b0", cloud: "#dcebdf", hill: "#3f6b4c", ground: "#5d8752", groundEdge: "#4d7544", groundDark: "#46663c", groundLight: "#739a64", accent: "#b06a45" },
      urban: { key: "urban", sky: ["#b6c3d4", "#c8d2dd", "#dadfe5"], sun: "#f3e9c5", cloud: "#eff2f4", hill: "#7c8894", ground: "#9aa3a3", groundEdge: "#86908f", groundDark: "#7e8887", groundLight: "#b2baba", accent: "#c2554d" },
      night: { key: "night", sky: ["#23304e", "#2d3c5e", "#3a4a6e"], sun: "#e8e6cf", cloud: "#46557454", hill: "#1d2a40", ground: "#33485a", groundEdge: "#2a3d4e", groundDark: "#243443", groundLight: "#41586c", accent: "#8ea4c8" }
    };

    function seededPixelRng(seedString) {
      let hash = 2166136261;
      for (let index = 0; index < seedString.length; index += 1) {
        hash ^= seedString.charCodeAt(index);
        hash = Math.imul(hash, 16777619);
      }
      return function rng() {
        hash += 0x6d2b79f5;
        let value = hash;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
      };
    }

    // Maps a battle's terrain (tile biome) to one of the 5 backdrop palettes.
    const TERRAIN_BACKDROP = {
      forest: BATTLE_BIOMES.forest,
      woodland: BATTLE_BIOMES.forest,
      grassland: BATTLE_BIOMES.meadow,
      agricultural: BATTLE_BIOMES.meadow,
      shrubland: BATTLE_BIOMES.meadow,
      desert: BATTLE_BIOMES.meadow,
      urban: BATTLE_BIOMES.urban,
      wetland: BATTLE_BIOMES.wetland,
      freshwater: BATTLE_BIOMES.wetland,
      polar: BATTLE_BIOMES.wetland,
      tundra: BATTLE_BIOMES.wetland
    };

    function pickBiome(battle) {
      // Prefer the battle's actual terrain; fall back to the combatants' types.
      if (battle.terrain && TERRAIN_BACKDROP[battle.terrain]) return TERRAIN_BACKDROP[battle.terrain];
      const types = []
        .concat(getActiveCreature(battle.opponent).types || [])
        .concat(getActiveCreature(battle.player).types || []);
      if (types.includes("Night")) return BATTLE_BIOMES.night;
      if (types.includes("Wetland")) return BATTLE_BIOMES.wetland;
      if (types.includes("Fungus") || types.includes("Decay") || types.includes("Wood")) return BATTLE_BIOMES.forest;
      if (types.includes("Urban")) return BATTLE_BIOMES.urban;
      return BATTLE_BIOMES.meadow;
    }

    function makePixelBackdropSvg(seedString, biome) {
      const rng = seededPixelRng(seedString + ":" + biome.key);
      const W = 64;
      const H = 36;
      let rects = "";
      const px = (x, y, w, h, fill) => {
        rects += '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="' + fill + '"/>';
      };

      const skyH = Math.floor(H * 0.6);
      for (let band = 0; band < biome.sky.length; band += 1) {
        const bandTop = Math.floor((skyH * band) / biome.sky.length);
        px(0, bandTop, W, Math.ceil(skyH / biome.sky.length) + 1, biome.sky[band]);
      }

      const sunX = 5 + Math.floor(rng() * 22);
      const sunY = 3 + Math.floor(rng() * 5);
      px(sunX, sunY, 4, 4, biome.sun);
      px(sunX + 1, sunY - 1, 2, 1, biome.sun);
      px(sunX + 1, sunY + 4, 2, 1, biome.sun);
      px(sunX - 1, sunY + 1, 1, 2, biome.sun);
      px(sunX + 4, sunY + 1, 1, 2, biome.sun);

      const cloudCount = 3 + Math.floor(rng() * 3);
      for (let i = 0; i < cloudCount; i += 1) {
        const cw = 5 + Math.floor(rng() * 6);
        const cx = Math.floor(rng() * (W - cw));
        const cy = 2 + Math.floor(rng() * (skyH - 8));
        px(cx, cy, cw, 2, biome.cloud);
        px(cx + 1, cy - 1, cw - 2, 1, biome.cloud);
      }

      let hillY = skyH - 4 - Math.floor(rng() * 4);
      for (let x = 0; x < W; x += 2) {
        hillY += Math.floor(rng() * 3) - 1;
        hillY = Math.max(skyH - 9, Math.min(skyH - 2, hillY));
        px(x, hillY, 2, skyH - hillY + 1, biome.hill);
      }

      px(0, skyH, W, H - skyH, biome.ground);
      px(0, skyH, W, 1, biome.groundEdge);

      for (let i = 0; i < 150; i += 1) {
        px(
          Math.floor(rng() * W),
          skyH + 1 + Math.floor(rng() * (H - skyH - 1)),
          1,
          1,
          rng() < 0.5 ? biome.groundDark : biome.groundLight
        );
      }

      for (let i = 0; i < 9; i += 1) {
        const tuftX = 1 + Math.floor(rng() * (W - 3));
        const tuftY = skyH + 2 + Math.floor(rng() * (H - skyH - 5));
        px(tuftX, tuftY, 1, 2, biome.accent);
        px(tuftX - 1, tuftY + 1, 1, 1, biome.groundDark);
        px(tuftX + 1, tuftY + 1, 1, 1, biome.groundDark);
      }

      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 36" shape-rendering="crispEdges">' + rects + '</svg>';
    }

    function battleBackdrop(battle) {
      const id = battle.battleId || "default";
      if (state.backdropCache && state.backdropCache.id === id) return state.backdropCache.css;
      const svg = makePixelBackdropSvg(id, pickBiome(battle));
      const css = "url(data:image/svg+xml," + encodeURIComponent(svg) + ")";
      state.backdropCache = { id, css };
      return css;
    }

    // -- Battle rendering ----------------------------------------------------

    function battleTitle(battle) {
      if (battle.mode === "territory_contest") return "Tile Contest";
      if (battle.mode === "pvp_async") return "Challenge Battle";
      if (battle.mode === "demo") return "5v5 Test Battle";
      return "NPC Battle";
    }

    function terrainBannerHtml(battle) {
      const terrain = battle.terrain;
      if (!terrain || terrain === "neutral" || !TERRAIN_MOVE_BONUS[terrain]) return "";
      const name = terrain.charAt(0).toUpperCase() + terrain.slice(1);
      const boosts = TERRAIN_MOVE_BONUS[terrain].join(" · ");
      return '<div class="terrain-banner">🌿 <strong>' + escapeHtml(name) + ' terrain</strong>' +
        ' <span class="subtle">— favors ' + escapeHtml(boosts) + ' moves (+15%)</span></div>';
    }

    function renderResultOverlay(battle) {
      const title = battle.status === "won" ? "Victory!" : battle.status === "lost" ? "Defeat" : "Draw";
      const cls = battle.status === "won" ? "win" : battle.status === "lost" ? "lose" : "";
      const contributions = battle.player.creatures
        .map((creature) => ({
          name: creature.name,
          dealt: Number(creature.damageDealt || 0),
          taken: Number(creature.damageTaken || 0)
        }))
        .filter((row) => row.dealt > 0 || row.taken > 0)
        .sort((a, b) => b.dealt - a.dealt);
      const contribHtml = contributions.length
        ? '<div class="overlay-contrib">' + contributions.map((row) =>
            '<div><strong>' + escapeHtml(row.name) + '</strong> &mdash; ' + row.dealt + ' dmg dealt / ' + row.taken + ' taken</div>'
          ).join("") + '</div>'
        : "";

      const update = battle.ratingUpdate;
      const ratingHtml = update
        ? '<div class="overlay-rating">' +
            '<span class="rating-delta ' + (update.delta >= 0 ? "up" : "down") + '">' +
              (update.delta >= 0 ? "+" : "") + update.delta + '</span>' +
            '<span>' + update.rating + ' Field Score</span>' +
            '<span class="lb-title-chip">' + escapeHtml((update.titleEmoji || "") + " " + (update.title || "")) + '</span>' +
            '<span>Rank #' + update.rank + '</span>' +
            (update.winStreak >= 2 ? '<span class="lb-streak">' + update.winStreak + '-win streak 🔥</span>' : "") +
          '</div>'
        : "";

      const canShare = battle.status === "won" && !battle.demo &&
        state.me && state.me.loggedIn && state.me.inatLogin && !state.me.guest;
      const canShareVideo = !battle.demo && (battle.status === "won" || battle.status === "lost") &&
        state.me && state.me.loggedIn && state.me.inatLogin;
      const actionsHtml = '<div class="overlay-actions">' +
        (canShare ? '<button class="secondary bsky-share-button" type="button" data-share-battle>Brag on Bluesky 🦋</button>' : "") +
        (canShareVideo ? '<button class="secondary" type="button" data-share-video="' + escapeAttr(battle.battleId) + '">Share as video 🎥</button>' : "") +
        (update ? '<button class="secondary" type="button" data-open-leaderboard>Leaderboard</button>' : "") +
        '<button class="primary" type="button" data-battle-exit>Back to Roster</button>' +
      '</div>';

      return '<div class="battle-overlay">' +
        '<div class="overlay-card">' +
          '<div class="overlay-title ' + cls + '">' + title + '</div>' +
          '<div class="overlay-sub">' + escapeHtml(battle.player.name || "Your Team") + " vs " + escapeHtml(battle.opponent.name || "Opponent") +
            " &middot; " + Math.max(1, Number(battle.turn || 1) - 1) + " turns</div>" +
          ratingHtml +
          contribHtml +
          actionsHtml +
        '</div>' +
      '</div>';
    }

    // Arena entry point shown when no battle is active: team slots, a readiness
    // checklist, and the actions that start a battle.
    function renderBattleEmptyState() {
      if (!els.battleEmptyState) return;
      const linked = !!(state.me && state.me.loggedIn && state.me.inatLogin);
      const summary = currentRosterSummary();
      const selectedCount = state.selectedTaxa.size;
      const teamReady = selectedCount === 5;
      const check = (ok, label) =>
        '<li class="battle-check' + (ok ? " done" : "") + '">' +
          '<span class="battle-check-mark">' + (ok ? "✓" : "○") + '</span>' +
          '<span>' + escapeHtml(label) + '</span>' +
        '</li>';

      els.battleEmptyState.innerHTML =
        '<div class="battle-entry">' +
          '<div class="battle-entry-head">' +
            '<div class="subtle">Battle Arena</div>' +
            '<h2>Ready a team, then fight</h2>' +
            '<p>Pick five ready species, then take on an NPC or challenge another naturalist on Bluesky.</p>' +
          '</div>' +
          renderHomeTeamSlots() +
          '<ul class="battle-checklist">' +
            check(linked, "iNaturalist roster imported") +
            check(summary.readyCount > 0, "At least one sprite ready to battle") +
            check(teamReady, "Five species selected (" + selectedCount + "/5)") +
          '</ul>' +
          '<div class="battle-entry-actions">' +
            '<button class="secondary" type="button" data-empty-action="pick-team">Pick Team</button>' +
            '<button class="primary" type="button" data-empty-action="battle-npc"' + (teamReady ? "" : " disabled") + '>Battle NPC</button>' +
            '<button class="secondary" type="button" data-empty-action="demo">Run 5v5 Test Battle</button>' +
          '</div>' +
          '<p class="subtle battle-entry-note">Want a human opponent? Open the Bluesky panel to send an async challenge — they play live while your snapshotted team is piloted by the AI.</p>' +
        '</div>';
    }

    function renderBattle() {
      const battle = state.battle;
      els.battlePanel.hidden = !battle;
      if (els.battleEmptyState) els.battleEmptyState.hidden = !!battle;
      document.body.classList.toggle("battle-active", !!battle);
      renderViewTabs();
      if (!battle) {
        state.swapOpen = false;
        renderBattleEmptyState();
        return;
      }

      const playerActive = getActiveCreature(battle.player);
      const opponentActive = getActiveCreature(battle.opponent);
      let moveButtons;
      if (battle.status === "active") {
        const playerMana = Number(playerActive.mana ?? 0);
        let anyAffordable = false;
        const buttons = playerActive.moves.map((move) => {
            const cost = moveManaCost(move);
            const affordable = playerMana >= cost;
            if (affordable) anyAffordable = true;
            const eff = move.category === "status" ? 1 : typeMultiplierFor(move.type, opponentActive.types);
            const effClass = eff >= 1.2 ? " eff-strong" : eff <= 0.85 ? " eff-weak" : "";
            const terrainBoost = move.category !== "status" && terrainBoostsMove(move.type, battle.terrain);
            const effLabel = "x" + eff.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
            const estimate = estimateMoveDamage(battle, playerActive, opponentActive, move);
            const metaBits = [];
            if (estimate !== null) {
              const multihit = move.effect && move.effect.kind === "multihit";
              metaBits.push(
                '<strong class="meta-dmg">~' + estimate + (multihit ? " x" + (move.effect.min || 2) + "-" + (move.effect.max || 3) : "") + " dmg</strong>" +
                (eff !== 1 ? ' <span class="eff-tag">' + effLabel + "</span>" : "")
              );
            }
            metaBits.push(...describeMoveEffect(move).map(escapeHtml));
            if (Number(move.accuracy) < 100) metaBits.push(Number(move.accuracy) + "% acc");
            return '<button class="move-button' + (move.signature ? " signature" : "") + effClass + (terrainBoost ? " eff-terrain" : "") + (affordable ? "" : " unaffordable") + '" type="button" data-move-id="' + escapeAttr(move.id) + '" ' +
              (move.flavor ? 'title="' + escapeAttr(move.flavor) + '" ' : "") + ((state.battleBusy || !affordable) ? "disabled" : "") + '>' +
              escapeHtml(move.name) + (move.signature ? ' <span class="sig-star">★</span>' : "") +
              (terrainBoost ? ' <span class="terrain-tag" title="Favored by the terrain (+15%)">🌿</span>' : "") +
              ' <span class="move-cost">' + cost + ' MP</span>' +
              '<br><span class="subtle">' + escapeHtml(move.type + " / " + move.category) + '</span>' +
              (metaBits.length ? '<span class="move-meta">' + metaBits.join(" · ") + '</span>' : "") +
            '</button>';
          }).join("");
        const struggle = anyAffordable
          ? ""
          : '<button class="struggle-button" type="button" data-move-id="struggle"' + (state.battleBusy ? " disabled" : "") + '>' +
              'Struggle <span class="subtle">— out of mana: weak hit + recoil</span>' +
            '</button>';
        moveButtons = buttons + struggle;
      } else {
        moveButtons = '<button class="move-button" type="button" disabled>Battle ' + escapeHtml(battle.status) + '</button>';
      }
      const recentLog = battle.log.slice(-8).reverse().map((entry) => (
        '<div>Turn ' + Number(entry.turn || 0) + ': ' + escapeHtml(entry.text) + '</div>'
      )).join("");

      let overlay = "";
      if (battle.status !== "active") {
        overlay = renderResultOverlay(battle);
      } else if (state.battlePhase === "intro") {
        overlay = '<div class="battle-overlay intro"><div class="overlay-title">Battle Start!</div></div>';
      }

      // Swap! lives in an action bar above the moves (not inside the clipped
      // stage) so it's always reachable, especially on mobile.
      const swappableCount = battle.status === "active"
        ? battle.player.creatures.filter((member, index) => index !== battle.player.activeIndex && !member.fainted).length
        : 0;
      const swapBar = swappableCount > 0
        ? '<div class="battle-actions">' +
            '<button type="button" class="swap-button" data-open-swap' + (state.battleBusy ? " disabled" : "") + '>' +
              'Swap! <span class="swap-count">' + swappableCount + '</span>' +
            '</button>' +
          '</div>'
        : "";

      els.battlePanel.innerHTML =
        '<div class="roster-head">' +
          '<h2>' + battleTitle(battle) + '</h2>' +
          '<div class="battle-head-tools">' +
            '<span class="subtle">' + escapeHtml(battle.status) + ' / turn ' + Number(battle.turn || 1) + '</span>' +
            '<button class="secondary" type="button" data-sound-toggle>' + (state.soundOn ? "Sound: on" : "Sound: off") + '</button>' +
            '<button class="secondary" type="button" data-battle-exit>Exit</button>' +
          '</div>' +
        '</div>' +
        terrainBannerHtml(battle) +
        '<div class="battle-stage" id="battleStage" style="background-image:' + battleBackdrop(battle) + '">' +
          renderCombatant(battle.player, playerActive, "player") +
          renderCombatant(battle.opponent, opponentActive, "opponent") +
          overlay +
        '</div>' +
        swapBar +
        '<div class="moves">' + moveButtons + '</div>' +
        '<div class="battle-log" id="battleLogPanel">' + recentLog + '</div>' +
        renderSwapModal(battle, playerActive);
      keyBattleSprites();
    }

    function renderSwapModal(battle, playerActive) {
      if (!state.swapOpen || battle.status !== "active") return "";
      const team = battle.player;
      const rows = team.creatures
        .map((member, index) => ({ member, index }))
        .filter(({ member, index }) => index !== team.activeIndex && !member.fainted);
      if (!rows.length) return "";

      const rowsHtml = rows.map(({ member, index }) => {
        const pct = member.maxHp ? Math.max(0, Math.round((member.hp / member.maxHp) * 100)) : 0;
        const manaPct = member.maxMana ? Math.max(0, Math.round((member.mana / member.maxMana) * 100)) : 0;
        const thumb = member.spriteUrl
          ? '<div class="swap-thumb" data-sprite-url="' + escapeAttr(member.spriteUrl) + '" style="background-image:url(&quot;' + escapeAttr(member.spriteUrl) + '&quot;)"></div>'
          : '<div class="swap-thumb swap-thumb-blank"></div>';
        const types = (member.types || []).join(" / ");
        return '<button type="button" class="swap-row" data-swap-index="' + index + '"' + (state.battleBusy ? " disabled" : "") + '>' +
          thumb +
          '<div class="swap-row-info">' +
            '<span class="swap-row-name">' + escapeHtml(member.name) +
              (Number(member.trainingLevel) > 0 ? ' <span class="lv-chip">Lv ' + Number(member.trainingLevel) + '</span>' : '') +
            '</span>' +
            (types ? '<span class="subtle swap-row-types">' + escapeHtml(types) + '</span>' : '') +
            '<div class="hp"><span class="' + (pct <= 25 ? "hp-low" : "") + '" style="--hp:' + pct + '%"></span></div>' +
            '<span class="subtle">' + Number(member.hp || 0) + ' / ' + Number(member.maxHp || 0) + ' HP</span>' +
            '<div class="mana"><span style="--mana:' + manaPct + '%"></span></div>' +
            '<span class="subtle mana-text">' + Number(member.mana || 0) + ' / ' + Number(member.maxMana || 0) + ' MP</span>' +
          '</div>' +
        '</button>';
      }).join("");

      return '<div class="swap-modal">' +
        '<div class="swap-sheet" role="dialog" aria-label="Swap species" aria-modal="true">' +
          '<div class="swap-sheet-head">' +
            '<strong>Swap species</strong>' +
            '<button type="button" class="secondary" data-swap-close>Close</button>' +
          '</div>' +
          '<p class="subtle swap-note">Pick a teammate to send in. The opponent still moves this turn.</p>' +
          '<div class="swap-list">' + rowsHtml + '</div>' +
        '</div>' +
      '</div>';
    }

    function renderCombatant(team, creature, side) {
      const hpPct = creature.maxHp ? Math.max(0, Math.round((creature.hp / creature.maxHp) * 100)) : 0;
      const manaPct = creature.maxMana ? Math.max(0, Math.round((creature.mana / creature.maxMana) * 100)) : 0;
      const animation = side === "player" ? state.battleAnimation : "anim-idle";
      const sprite = creature.spriteUrl
        ? renderSheetSprite(creature.spriteUrl, animation + (creature.fainted ? " fainted" : ""))
        : '<div class="dummy-sprite' + (creature.fainted ? " fainted" : "") + '">Dummy</div>';
      // The Swap! button is rendered in the action bar above the moves (see
      // renderBattle) so it stays visible on mobile — the plate sits inside the
      // height-clipped battle-stage where a tall plate would hide it.
      const STATUS_SPRITE_KINDS = ["stunned", "marked", "poisoned", "shielded", "rallied"];
      const activeStatuses = (creature.statuses || []).slice();
      if (creature.rallied) activeStatuses.push("rallied");
      const statusSprites = !creature.fainted
        ? activeStatuses
            .filter((status, index) => STATUS_SPRITE_KINDS.includes(status) && activeStatuses.indexOf(status) === index)
            .map((status) => {
              const url = "/assets/status-" + status + ".png";
              return '<div class="status-sprite" data-sprite-url="' + escapeAttr(url) + '" title="' + escapeAttr(status) + '" ' +
                'style="background-image:url(&quot;' + escapeAttr(url) + '&quot;)"></div>';
            }).join("")
        : "";

      return '<article class="combatant ' + side + '">' +
        '<div class="plate">' +
          '<div class="combatant-head">' +
            '<div class="combatant-name">' + escapeHtml(creature.name) +
              (Number(creature.trainingLevel) > 0 ? ' <span class="lv-chip">Lv ' + Number(creature.trainingLevel) + '</span>' : '') +
              (Number(creature.trainingBuffPct) > 0 ? ' <span class="lv-chip">+' + Math.round(Number(creature.trainingBuffPct) * 100) + '% mastery</span>' : '') +
              (Number(creature.territoryBuffPct) > 0 ? ' <span class="lv-chip terr-chip">🏞️ +' + Math.round(Number(creature.territoryBuffPct) * 100) + '% home</span>' : '') +
              (Number(creature.localBuffPct) > 0 ? ' <span class="lv-chip local-chip">📍 +' + Math.round(Number(creature.localBuffPct) * 100) + '% local</span>' : '') +
            '</div>' +
            '<div class="combatant-role">' + escapeHtml((creature.types || []).join(" / ")) + '</div>' +
          '</div>' +
          '<div class="hp" aria-label="HP"><span data-hp-bar="' + side + '" class="' + (hpPct <= 25 ? "hp-low" : "") + '" style="--hp:' + hpPct + '%"></span></div>' +
          '<div class="subtle" data-hp-text="' + side + '">' + Number(creature.hp || 0) + ' / ' + Number(creature.maxHp || 0) + ' HP</div>' +
          '<div class="mana" aria-label="Mana"><span style="--mana:' + manaPct + '%"></span></div>' +
          '<div class="subtle mana-text">' + Number(creature.mana || 0) + ' / ' + Number(creature.maxMana || 0) + ' MP</div>' +
          (function () {
            const statusChips = (creature.statuses || []).map((status) => (
              '<span class="status-chip status-' + escapeAttr(status) + '">' + escapeHtml(status) + '</span>'
            )).join("");
            const stageAbbrev = { vigor: "VIG", strike: "STR", guard: "GRD", tempo: "TMP", sense: "SNS" };
            const stageChips = Object.entries(creature.statStages || {})
              .filter(([, value]) => Number(value))
              .map(([stat, value]) => {
                const stage = Number(value);
                return '<span class="stage-chip ' + (stage > 0 ? "up" : "down") + '">' +
                  (stageAbbrev[stat] || stat.slice(0, 3).toUpperCase()) + " " + (stage > 0 ? "+" : "") + stage +
                '</span>';
              }).join("");
            return statusChips || stageChips
              ? '<div class="status-chips">' + statusChips + stageChips + '</div>'
              : "";
          })() +
        '</div>' +
        '<div class="combatant-sprite" data-sprite-zone="' + side + '">' +
          '<div class="platform"></div>' + sprite +
          (statusSprites ? '<div class="status-sprites">' + statusSprites + '</div>' : "") +
        '</div>' +
      '</article>';
    }

    function renderSheetSprite(url, animationClass) {
      return '<div class="sheet-sprite ' + escapeAttr(animationClass || "anim-idle") + '" data-sprite-url="' + escapeAttr(url) + '" style="background-image:url(&quot;' + escapeAttr(url) + '&quot;)"></div>';
    }

    const keyedSpriteCache = new Map();

    function keyBattleSprites() {
      const sprites = els.battlePanel.querySelectorAll(
        ".combatant-sprite .sheet-sprite[data-sprite-url], .combatant-sprite .status-sprite[data-sprite-url], .swap-thumb[data-sprite-url]"
      );
      sprites.forEach((sprite) => {
        const url = sprite.getAttribute("data-sprite-url");
        if (!url) return;

        const cached = keyedSpriteCache.get(url);
        if (typeof cached === "string") {
          setSpriteBackground(sprite, cached);
          return;
        }
        if (cached && typeof cached.then === "function") {
          cached.then((keyedUrl) => {
            if (sprite.isConnected && sprite.getAttribute("data-sprite-url") === url) {
              setSpriteBackground(sprite, keyedUrl);
            }
          });
          return;
        }

        const pending = makeTransparentSpriteUrl(url)
          .then((keyedUrl) => {
            keyedSpriteCache.set(url, keyedUrl);
            return keyedUrl;
          })
          .catch(() => {
            keyedSpriteCache.delete(url);
            return url;
          });
        keyedSpriteCache.set(url, pending);
        pending.then((keyedUrl) => {
          if (sprite.isConnected && sprite.getAttribute("data-sprite-url") === url) {
            setSpriteBackground(sprite, keyedUrl);
          }
        });
      });
    }

    function setSpriteBackground(sprite, url) {
      sprite.style.backgroundImage = 'url("' + url + '")';
      sprite.classList.add("alpha-keyed");
    }

    function makeTransparentSpriteUrl(url) {
      return new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          try {
            const width = image.naturalWidth || image.width;
            const height = image.naturalHeight || image.height;
            if (!width || !height) {
              resolve(url);
              return;
            }

            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d", { willReadFrequently: true });
            context.drawImage(image, 0, 0);
            const imageData = context.getImageData(0, 0, width, height);
            alphaKeySpriteSheet(imageData.data, width, height);
            context.putImageData(imageData, 0, 0);
            canvas.toBlob((blob) => {
              resolve(blob ? URL.createObjectURL(blob) : url);
            }, "image/png");
          } catch (error) {
            reject(error);
          }
        };
        image.onerror = () => reject(new Error("Sprite image could not be loaded"));
        image.src = url;
      });
    }

    function alphaKeySpriteSheet(data, width, height) {
      const columns = 4;
      const rows = 4;
      const visited = new Uint8Array(width * height);

      for (let row = 0; row < rows; row += 1) {
        for (let column = 0; column < columns; column += 1) {
          const x0 = Math.floor((width * column) / columns);
          const x1 = Math.floor((width * (column + 1)) / columns) - 1;
          const y0 = Math.floor((height * row) / rows);
          const y1 = Math.floor((height * (row + 1)) / rows) - 1;
          const queue = [];
          let cursor = 0;

          const push = (x, y) => {
            if (x < x0 || x > x1 || y < y0 || y > y1) return;
            const index = y * width + x;
            if (visited[index]) return;
            if (!isLightCellBackground(data, index * 4)) return;
            visited[index] = 1;
            queue.push(index);
          };

          for (let x = x0; x <= x1; x += 1) {
            push(x, y0);
            push(x, y1);
          }
          for (let y = y0 + 1; y < y1; y += 1) {
            push(x0, y);
            push(x1, y);
          }

          while (cursor < queue.length) {
            const index = queue[cursor];
            cursor += 1;
            data[index * 4 + 3] = 0;

            const x = index % width;
            const y = Math.floor(index / width);
            push(x + 1, y);
            push(x - 1, y);
            push(x, y + 1);
            push(x, y - 1);
          }
        }
      }
    }

    function isLightCellBackground(data, offset) {
      const alpha = data[offset + 3];
      if (alpha === 0) return false;

      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const max = Math.max(red, green, blue);
      const min = Math.min(red, green, blue);

      return max >= 190 && max - min <= 70 && red + green + blue >= 590;
    }

    function getActiveCreature(team) {
      return team.creatures[team.activeIndex || 0];
    }

    // Refresh the roster while sprites are actively generating. Only queued /
    // running sprites can change on their own ("missing" needs a user or admin
    // action first, so it would poll forever), the interval backs off toward a
    // minute, and a hidden tab skips the fetch instead of hammering the API.
    function schedulePolling() {
      if (state.polling) clearTimeout(state.polling);

      const hasPending = state.taxa.some((taxon) => ["queued", "running"].includes(taxon.sprite.status));
      if (!hasPending) {
        state.pollDelayMs = 0;
        return;
      }

      state.pollDelayMs = state.pollDelayMs ? Math.min(60000, Math.round(state.pollDelayMs * 1.5)) : 8000;
      state.polling = setTimeout(async () => {
        if (document.hidden) {
          schedulePolling();
          return;
        }
        try {
          await loadRoster();
        } catch (error) {
          setStatus(error.message);
        }
      }, state.pollDelayMs);
    }

    async function apiFetch(path, init) {
      const res = await fetch(path, init);
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        throw new Error(data.error || "Request failed (" + res.status + ")");
      }

      return data;
    }

    function setBusy(isBusy, message) {
      els.importButton.disabled = isBusy;
      els.manualUploadButton.disabled = isBusy;
      els.manualTaxonId.disabled = isBusy;
      els.manualSpriteFile.disabled = isBusy;
      els.treeSearchInput.disabled = isBusy;
      els.treeRefreshButton.disabled = isBusy;
      els.recentSearchInput.disabled = isBusy;
      els.recentRefreshButton.disabled = isBusy;
      els.clearTeamButton.disabled = isBusy || state.selectedTaxa.size === 0;
      els.startBattleButton.disabled = isBusy || !state.userId || state.selectedTaxa.size !== 5;
      if (message) setStatus(message);
    }

    function delay(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }

    function debounce(fn, waitMs) {
      let timeoutId;
      return (...args) => {
        if (timeoutId) clearTimeout(timeoutId);
        timeoutId = setTimeout(() => fn(...args), waitMs);
      };
    }

    function setStatus(message) {
      els.statusLine.textContent = message || "";
    }

    function escapeHtml(value) {
      return String(value ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
      }[char]));
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/\x60/g, "&#96;");
    }
