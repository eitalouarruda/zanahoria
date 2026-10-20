import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { LANGUAGES, useT, type MessageKey } from "../../i18n";
import {
  ACTIONS,
  ACTION_BY_ID,
  comboFromEvent,
  formatShortcut,
  isModifierOnly,
  keysFor,
  type ActionGroup,
  type ActionId,
} from "../../lib/keymap";
import { setShortcutsSuspended } from "../../lib/shortcuts";
import {
  uiZoomFor,
  useSettings,
  type Language,
  type ThemeSetting,
} from "../../stores/settingsStore";

const GROUPS: { id: ActionGroup; label: MessageKey }[] = [
  { id: "general", label: "settings.group.general" },
  { id: "tabs", label: "settings.group.tabs" },
  { id: "editor", label: "settings.group.editor" },
  { id: "results", label: "settings.group.results" },
];

const THEMES: { value: ThemeSetting; label: MessageKey }[] = [
  { value: "dark", label: "settings.theme.dark" },
  { value: "light", label: "settings.theme.light" },
  { value: "system", label: "settings.theme.system" },
];

/** Tras el primer paso, espera este tiempo un segundo paso (secuencia). */
const SEQUENCE_WAIT_MS = 900;

/** Atajo que se está grabando: reemplaza `index` o agrega uno nuevo (null). */
interface Recording {
  action: ActionId;
  index: number | null;
  steps: string[];
}

export default function SettingsView() {
  const t = useT();
  const settings = useSettings();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    void getVersion().then(setVersion).catch(() => {});
  }, []);

  return (
    <div className="global-view settings-view">
      <div className="cm-header">
        <h2>⚙ {t("settings.title")}</h2>
      </div>

      <section className="settings-section">
        <h3>{t("settings.general")}</h3>
        <div className="settings-row">
          <label htmlFor="settings-language">{t("settings.language")}</label>
          <select
            id="settings-language"
            value={settings.language}
            onChange={(e) => settings.setLanguage(e.target.value as Language)}
          >
            {LANGUAGES.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </select>
        </div>
        <div className="settings-row">
          <span>{t("settings.theme")}</span>
          <div className="segmented" role="radiogroup" aria-label={t("settings.theme")}>
            {THEMES.map((th) => (
              <button
                key={th.value}
                role="radio"
                aria-checked={settings.theme === th.value}
                className={settings.theme === th.value ? "active" : undefined}
                onClick={() => settings.setTheme(th.value)}
              >
                {t(th.label)}
              </button>
            ))}
          </div>
        </div>
        <div className="settings-row">
          <label htmlFor="settings-font">{t("settings.editorFont")}</label>
          <input
            id="settings-font"
            type="number"
            min={9}
            max={28}
            value={settings.editorFontSize}
            onChange={(e) => settings.setEditorFontSize(Number(e.target.value) || 13)}
          />
        </div>
        <UiZoomRow />
        {version && (
          <div className="settings-row">
            <span>{t("settings.version")}</span>
            <span className="dim">v{version}</span>
          </div>
        )}
      </section>

      <ShortcutsSection />
    </div>
  );
}

/** Tamaño de la interfaz en la pantalla donde está la ventana. */
function UiZoomRow() {
  const t = useT();
  const { monitor, uiZoom, shortcuts, changeUiZoom } = useSettings();
  if (monitor === null) return null;
  const auto = uiZoom[monitor] === undefined;
  const zoom = uiZoomFor({ monitor, uiZoom });
  const hint = (label: MessageKey, action: ActionId) => {
    const keys = keysFor(action, shortcuts);
    return keys.length > 0 ? `${t(label)} (${formatShortcut(keys[0])})` : t(label);
  };
  return (
    <div className="settings-row">
      <span>
        {t("settings.uiZoom")}{" "}
        <small className="dim">
          ({monitor}
          {auto ? `, ${t("settings.uiZoom.autoShort")}` : ""})
        </small>
      </span>
      <div className="ui-zoom">
        <button onClick={() => changeUiZoom(-1)} title={hint("settings.uiZoom.out", "uiZoomOut")}>
          −
        </button>
        <span className="ui-zoom-value">{Math.round(zoom * 100)} %</span>
        <button onClick={() => changeUiZoom(1)} title={hint("settings.uiZoom.in", "uiZoomIn")}>
          +
        </button>
        <button
          onClick={() => changeUiZoom(0)}
          disabled={auto}
          title={hint("settings.uiZoom.reset", "uiZoomReset")}
        >
          {t("settings.uiZoom.auto")}
        </button>
      </div>
    </div>
  );
}

function ShortcutsSection() {
  const t = useT();
  const { shortcuts, setShortcut, resetShortcut, resetAllShortcuts } = useSettings();
  const [recording, setRecording] = useState<Recording | null>(null);
  const timer = useRef<number | null>(null);

  // Mientras se graba, los atajos de la app no se disparan.
  useEffect(() => {
    setShortcutsSuspended(recording !== null);
    return () => setShortcutsSuspended(false);
  }, [recording]);

  const commit = (rec: Recording) => {
    const combo = rec.steps.join(" ");
    const current = keysFor(rec.action, shortcuts);
    const next =
      rec.index === null
        ? [...current.filter((k) => k !== combo), combo]
        : current.map((k, i) => (i === rec.index ? combo : k));
    setShortcut(rec.action, Array.from(new Set(next)));
    setRecording(null);
  };

  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      if (isModifierOnly(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (timer.current) window.clearTimeout(timer.current);
      if (e.key === "Escape" && recording.steps.length === 0) {
        setRecording(null);
        return;
      }
      const steps = [...recording.steps, comboFromEvent(e)];
      if (steps.length >= 2) {
        commit({ ...recording, steps });
        return;
      }
      const rec = { ...recording, steps };
      setRecording(rec);
      // Sin segunda tecla en poco tiempo: queda como atajo de un paso.
      timer.current = window.setTimeout(() => commit(rec), SEQUENCE_WAIT_MS);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording]);

  /** Otras acciones que usan la misma combinación. */
  const conflictsOf = (action: ActionId, combo: string) =>
    ACTIONS.filter((a) => a.id !== action && keysFor(a.id, shortcuts).includes(combo));

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>{t("settings.shortcuts")}</h3>
        <button onClick={resetAllShortcuts}>{t("settings.resetAll")}</button>
      </div>
      <p className="dim">{t("settings.shortcutsHint")}</p>
      {GROUPS.map((g) => (
        <div key={g.id} className="shortcut-group">
          <h4>{t(g.label)}</h4>
          {ACTIONS.filter((a) => a.group === g.id).map((a) => {
            const keys = keysFor(a.id, shortcuts);
            const customized = shortcuts[a.id] !== undefined;
            const isRecording = recording?.action === a.id;
            return (
              <div key={a.id} className={`shortcut-row ${customized ? "customized" : ""}`}>
                <span className="shortcut-label">{t(a.label)}</span>
                <div className="shortcut-keys">
                  {keys.length === 0 && !isRecording && (
                    <span className="dim">{t("settings.noShortcut")}</span>
                  )}
                  {keys.map((k, i) =>
                    isRecording && recording.index === i ? (
                      <kbd key={k} className="recording">
                        {recording.steps.length > 0
                          ? `${formatShortcut(recording.steps.join(" "))} …`
                          : t("settings.recording")}
                      </kbd>
                    ) : (
                      <span key={k} className="shortcut-chip">
                        <button
                          className="kbd-button"
                          title={conflictsOf(a.id, k)
                            .map((c) => t("settings.conflict", { action: t(c.label) }))
                            .join("\n")}
                          onClick={() => setRecording({ action: a.id, index: i, steps: [] })}
                        >
                          <kbd className={conflictsOf(a.id, k).length > 0 ? "conflict" : undefined}>
                            {formatShortcut(k)}
                          </kbd>
                        </button>
                        <button
                          className="chip-remove"
                          aria-label={`${t("common.delete")} ${formatShortcut(k)}`}
                          onClick={() => setShortcut(a.id, keys.filter((_, j) => j !== i))}
                        >
                          ×
                        </button>
                      </span>
                    ),
                  )}
                  {isRecording && recording.index === null && (
                    <kbd className="recording">
                      {recording.steps.length > 0
                        ? `${formatShortcut(recording.steps.join(" "))} …`
                        : t("settings.recording")}
                    </kbd>
                  )}
                </div>
                <div className="shortcut-actions">
                  <button onClick={() => setRecording({ action: a.id, index: null, steps: [] })}>
                    {t("settings.add")}
                  </button>
                  {customized && (
                    <button onClick={() => resetShortcut(a.id)}>{t("settings.reset")}</button>
                  )}
                </div>
                {keys.some((k) => conflictsOf(a.id, k).length > 0) && (
                  <span className="shortcut-conflict">
                    {Array.from(
                      new Set(
                        keys.flatMap((k) =>
                          conflictsOf(a.id, k).map((c) =>
                            t("settings.conflict", { action: t(ACTION_BY_ID[c.id].label) }),
                          ),
                        ),
                      ),
                    ).join(" · ")}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </section>
  );
}
