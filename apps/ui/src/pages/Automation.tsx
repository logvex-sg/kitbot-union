import { useState } from 'react';
import { Api } from '../api';
import { usePoll } from '../hooks';
import { Card, Empty, Row, str } from '../ui';

const SETTINGS_KEYS = [
  { key: 'navigation.goalRadius', label: 'goal radius (blocks)' },
  { key: 'navigation.pathTimeoutMs', label: 'path timeout (ms)' },
  { key: 'navigation.stuckThreshold', label: 'stuck threshold (ms)' },
  { key: 'storage.scanRadius', label: 'scan radius (blocks)' },
  { key: 'delivery.approachDistance', label: 'delivery approach distance' },
  { key: 'delivery.verifyTimeoutMs', label: 'delivery verify timeout (ms)' },
  { key: 'reconnect.baseDelayMs', label: 'reconnect base delay (ms)' },
  { key: 'reconnect.maxDelayMs', label: 'reconnect max delay (ms)' },
  { key: 'reconnect.maxAttempts', label: 'reconnect max attempts (0 = unlimited)' },
  { key: 'chat.greetingMessage', label: 'greeting reply text' },
];

const TPA_MODES = ['DISABLED', 'TRUSTED_ONLY', 'ALLOW_LIST', 'MANUAL', 'CUSTOM_RULES'];

export function Automation({ api }: { api: Api }) {
  const bots = usePoll(() => api.bots(), 10000);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [tpa, setTpa] = useState({
    mode: 'TRUSTED_ONLY',
    timeoutMs: '60000',
    trusted: '',
    blocked: '',
  });

  const bot = ((bots.data?.bots ?? []) as Array<Record<string, unknown>>)[0];

  const saveNumeric = async () => {
    if (!bot) return;
    const payload: Record<string, unknown> = {};
    for (const [path, value] of Object.entries(draft)) {
      if (value === '') continue;
      const [section = 'misc', key = 'value'] = path.split('.');
      const numeric = Number(value);
      const target = (payload[section] ??= {}) as Record<string, unknown>;
      target[key] = Number.isFinite(numeric) && !Number.isNaN(numeric) ? numeric : value;
    }
    if (Object.keys(payload).length === 0) {
      setMessage('nothing to save');
      return;
    }
    try {
      await api.botSettings(String(bot.id), payload);
      setMessage('settings saved');
      setDraft({});
      await bots.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'save failed');
    }
  };

  const saveTpa = async () => {
    if (!bot) return;
    try {
      await api.botSettings(String(bot.id), {
        tpa: {
          enabled: tpa.mode !== 'DISABLED',
          mode: tpa.mode,
          timeoutMs: Number(tpa.timeoutMs) || 60000,
          trustedPlayers: tpa.trusted
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
          blockedPlayers: tpa.blocked
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
        },
      });
      setMessage('TPA settings saved');
      await bots.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'save failed');
    }
  };

  const quickCommand = async (command: string, args: string[] = []) => {
    if (!bot) return;
    try {
      const result = await api.botCommand(String(bot.id), command, args);
      setMessage(`${command}: ${str(result.message, 'ok')}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'command failed');
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Automation</h1>
        <span className="sub">runtime tuning and TPA policy</span>
      </div>
      {message ? (
        <div className="toolbar">
          <span className="muted mono-sm">{message}</span>
        </div>
      ) : null}

      <div className="grid">
        <Card title="Navigation & runtime" className="span-2">
          <div className="form-row">
            {SETTINGS_KEYS.map((item) => (
              <div className="field" key={item.key}>
                <label>{item.label}</label>
                <input
                  value={draft[item.key] ?? ''}
                  placeholder="unchanged"
                  onChange={(e) => setDraft({ ...draft, [item.key]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <button className="primary" onClick={saveNumeric} disabled={!bot}>
            save settings
          </button>
        </Card>

        <Card title="TPA policy">
          <div className="field">
            <label>mode</label>
            <select value={tpa.mode} onChange={(e) => setTpa({ ...tpa, mode: e.target.value })}>
              {TPA_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>timeout (ms)</label>
            <input
              value={tpa.timeoutMs}
              onChange={(e) => setTpa({ ...tpa, timeoutMs: e.target.value })}
            />
          </div>
          <div className="field">
            <label>trusted players (comma separated)</label>
            <input
              value={tpa.trusted}
              onChange={(e) => setTpa({ ...tpa, trusted: e.target.value })}
            />
          </div>
          <div className="field">
            <label>blocked players (comma separated)</label>
            <input
              value={tpa.blocked}
              onChange={(e) => setTpa({ ...tpa, blocked: e.target.value })}
            />
          </div>
          <button className="primary" onClick={saveTpa} disabled={!bot}>
            save TPA policy
          </button>
        </Card>

        <Card title="Quick actions">
          <div className="row-actions">
            <button className="sm" disabled={!bot} onClick={() => quickCommand('stopnav')}>
              stop navigation
            </button>
            <button className="sm" disabled={!bot} onClick={() => quickCommand('inventory')}>
              refresh inventory
            </button>
            <button className="sm" disabled={!bot} onClick={() => quickCommand('scan')}>
              scan here
            </button>
            <button className="sm" disabled={!bot} onClick={() => quickCommand('players')}>
              list players
            </button>
          </div>
          <div className="stack" style={{ marginTop: 10 }}>
            <Row k="active bot" v={bot ? `${str(bot.name)} (${str(bot.username)})` : 'none'} />
            <Row k="auto-connect" v={bot ? (bot.autoConnect ? 'yes' : 'no') : '-'} />
            <Row k="auth" v={bot ? str(bot.authType) : '-'} />
          </div>
        </Card>
      </div>

      {!bot ? (
        <Card className="span-full" title="Tip">
          <Empty>register a bot on the Bots page first</Empty>
        </Card>
      ) : null}
    </>
  );
}
