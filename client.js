/**
 * Browser half of dsh-qa-isolation: one compact switch in the composer
 * tool row, beside Send.
 *
 * It reads and writes the mode through this package's own Host route
 * (`/dsh-qa/mode`), which settles the change as a real `/qa` command run, so
 * the durable log stays the single source of truth for the mode and the typed
 * command and this button cannot drift apart.
 *
 * Slot props differ between harness builds, so the Session is resolved
 * defensively; with no resolvable Session the control hides itself rather
 * than acting on a session the page may not be viewing, and `/qa` remains
 * the switch.
 */
window.__ModuleLoader__.load({
	id: "dsh-qa-isolation",
	factory(require) {
		const React = require("react");
		const h = React.createElement;

		const STYLE = [
			".dshqa-toggle { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px 0 8px;",
			"  border: 1px solid var(--dsw-alias-border, rgba(128,128,128,.35)); border-radius: 13px;",
			"  background: transparent; color: var(--dsw-alias-text-secondary, inherit);",
			"  font-size: 12px; line-height: 1; cursor: pointer; }",
			".dshqa-toggle:disabled { cursor: default; opacity: .55; }",
			".dshqa-toggle .dshqa-dot { width: 7px; height: 7px; border-radius: 50%;",
			"  background: var(--dsw-alias-text-tertiary, currentColor); flex: none; }",
			".dshqa-toggle[data-mode='follow'] { border-color: var(--dsw-alias-accent, #247bbf);",
			"  color: var(--dsw-alias-text-primary, inherit); }",
			".dshqa-toggle[data-mode='follow'] .dshqa-dot { background: var(--dsw-alias-accent, #247bbf); }",
		].join("\n");

		const LABELS = {
			fresh: { text: "单问", title: "单问模式：下一个问题起会移除此前的问答。点击切到追问模式。" },
			follow: { text: "追问", title: "追问模式：保留当前仍在上下文里的问答（已被移除的不会恢复）。点击切回单问模式。" },
			unknown: { text: "单问", title: "未能读取本会话的模式；可用 /qa fresh 或 /qa follow 切换。" },
		};

		/** The Session this client is currently viewing, from its session snapshot. */
		function mainViewSession(snapshot) {
			const byId = snapshot?.byId || {};
			for (const id of Array.isArray(snapshot?.ids) && snapshot.ids.length ? snapshot.ids : Object.keys(byId)) {
				if (byId[id]?.retainedBy?.mainView) return id;
			}
			return undefined;
		}

		/**
		 * Current Session id for this seat.
		 *
		 * `useSessions(selector)` is the standard ui-session prop and answers the
		 * Session this page is actually looking at; the direct props are tried
		 * first because a seat may already carry its own exact Session.
		 */
		/**
		 * Current Session id for this seat.
		 *
		 * Known keys are tried first, then a shallow scan for any value shaped
		 * like a Session id (`session-<uuid>`): the seat's exact prop names vary
		 * between harness builds, while the identifier shape does not.
		 */
		/**
		 * Current Session id for this seat.
		 *
		 * Known keys are tried first, then a shallow scan for any value shaped
		 * like a Session id (`session-<uuid>`): the seat's exact prop names vary
		 * between harness builds, while the identifier shape does not.
		 * `useSessions` is a React hook, so its result arrives as an argument —
		 * the caller reads it unconditionally.
		 */
		const SESSION_ID = /^session-[0-9a-f-]{8,}$/i;
		function findSessionId(value, depth) {
			if (typeof value === "string") return SESSION_ID.test(value) ? value : undefined;
			if (value === null || typeof value !== "object" || depth <= 0) return undefined;
			if (Array.isArray(value)) {
				for (const item of value) {
					const found = findSessionId(item, depth - 1);
					if (found !== undefined) return found;
				}
				return undefined;
			}
			for (const key of Object.keys(value)) {
				let found;
				try {
					found = findSessionId(value[key], depth - 1);
				} catch {
					continue;
				}
				if (found !== undefined) return found;
			}
			return undefined;
		}

		function sessionIdOf(props, selected) {
			if (typeof selected === "string" && SESSION_ID.test(selected)) return selected;
			if (props !== null && typeof props === "object") {
				if (typeof props.sessionId === "string" && SESSION_ID.test(props.sessionId)) return props.sessionId;
				if (typeof props.session?.id === "string" && SESSION_ID.test(props.session.id)) return props.session.id;
				if (typeof props.binding?.sessionId === "string" && SESSION_ID.test(props.binding.sessionId)) return props.binding.sessionId;
				const found = findSessionId(props, 3);
				if (found !== undefined) return found;
			}
			// Some builds address the Session through the page location instead.
			try {
				for (const source of [window.location.search, window.location.hash]) {
					const match = /(session-[0-9a-f-]{8,})/i.exec(source || "");
					if (match) return match[1];
				}
			} catch {
				/* No location access: leave unresolved. */
			}
			return undefined;
		}

		function QaToggle(props) {
			// Hooks run unconditionally: read the standard session source first.
			const selected = typeof props?.useSessions === "function" ? props.useSessions(mainViewSession) : undefined;
			const knownSessionId = sessionIdOf(props, selected);
			const [state, setState] = React.useState(undefined);
			const [busy, setBusy] = React.useState(false);

			const query = React.useCallback(
				(signal) => {
					const q = knownSessionId === undefined ? "" : `?sessionId=${encodeURIComponent(knownSessionId)}`;
					return fetch(`/dsh-qa/mode${q}`, { method: "GET", credentials: "same-origin", signal })
						.then((res) => {
							if (!res.ok) throw new Error(`HTTP ${res.status}`);
							return res.json();
						});
				},
				[knownSessionId],
			);

			React.useEffect(() => {
				const controller = new AbortController();
				setState(undefined);
				query(controller.signal)
					.then((value) => {
						if (!controller.signal.aborted) setState(value);
					})
					.catch(() => {
						/* A failed read leaves the control hidden; `/qa` still works. */
					});
				return () => controller.abort();
			}, [query]);

			// Re-read when the page regains focus, so the label follows the
			// session the reader is actually looking at.
			React.useEffect(() => {
				const onVisible = () => {
					if (document.visibilityState !== "visible") return;
					query().then(setState).catch(() => undefined);
				};
				document.addEventListener("visibilitychange", onVisible);
				return () => document.removeEventListener("visibilitychange", onVisible);
			}, [query]);

			const onClick = React.useCallback(() => {
				if (busy) return;
				const next = state?.mode === "follow" ? "fresh" : "follow";
				setBusy(true);
				const q = knownSessionId === undefined ? "" : `?sessionId=${encodeURIComponent(knownSessionId)}`;
				fetch(`/dsh-qa/mode${q}`, {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ mode: next }),
				})
					.then((res) => {
						if (!res.ok) throw new Error(`HTTP ${res.status}`);
						return res.json();
					})
					.then(setState)
					.catch(() => setState(state))
					.finally(() => setBusy(false));
			}, [state, busy, knownSessionId]);

			// Show only for a live session under the isolation preset: the Host
			// answers `available: false` for any other preset, and the control
			// would otherwise claim a session this page is not viewing.
			if (state?.available !== true) return null;
			const view = state.mode === "follow" || state.mode === "fresh" ? state.mode : "unknown";
			const label = LABELS[view];
			const title = label.title;
			// Styles render inside this component so unmounting removes them.
			return h(
				React.Fragment,
				null,
				h("style", null, STYLE),
				h(
					"button",
					{
						type: "button",
						className: "dshqa-toggle",
						"data-mode": view === "follow" ? "follow" : "fresh",
						"data-composer-qa": "true",
						title,
						disabled: busy || view === "unknown",
						onClick,
					},
					h("span", { className: "dshqa-dot", "aria-hidden": true }),
					h("span", null, busy ? "…" : label.text),
				),
			);
		}

		return {
			inject: ["slots"],
			apply(ctx) {
				// Preferred seat: the composer tool row, beside Send. The dock under
				// the composer card is the fallback for a build without that seat.
				// Either injection can fire first, so the loser withdraws: exactly one
				// control shows whichever order this harness build uses.
				let primaryOn = false;
				let fallbackOn = false;
				let disposeFallback;
				const install = (name, isPrimary) => {
					let disposeInject;
					try {
						disposeInject = ctx.slots.inject(name, () => {
							if (isPrimary) primaryOn = true;
							else if (primaryOn) return;
							try {
								const disposeRegister = ctx.slots.register({ name, id: "qa-isolation", order: 5 }, QaToggle);
								if (isPrimary) {
									if (fallbackOn && typeof disposeFallback === "function") disposeFallback();
								} else {
									fallbackOn = true;
									disposeFallback = disposeRegister;
								}
								return disposeRegister;
							} catch {
								/* Seat refused this build: leave it. */
							}
						});
					} catch {
						return undefined;
					}
					return disposeInject;
				};
				const disposers = [install("conversation.input.right", true), install("conversation.composer.dock", false)];

				return () => {
					for (const dispose of disposers) {
						if (typeof dispose !== "function") continue;
						try {
							dispose();
						} catch {
							/* Already released. */
						}
					}
				};
			},
		};
	},
});
