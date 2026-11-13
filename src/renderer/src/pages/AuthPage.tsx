/** Ecranul de autentificare: login, înregistrare și intrarea în contul demo. */
import { useState, type FormEvent } from 'react';
import { ChartNoAxesCombined, FlaskConical, ShieldCheck } from 'lucide-react';
import { api, errorMessage } from '../api';
import { useApp } from '../context/AppContext';
import { Button, Field, Input, Notice } from '../components/ui';

type Mode = 'login' | 'register';

export function AuthPage() {
  const { setUser } = useApp();
  const [mode, setMode] = useState<Mode>('login');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'form' | 'demo' | null>(null);

  const switchMode = (next: Mode): void => {
    setMode(next);
    setError(null);
    setPassword('');
    setConfirm('');
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    setError(null);
    if (mode === 'register' && password !== confirm) {
      setError('Parolele nu coincid.');
      return;
    }
    setBusy('form');
    try {
      const user =
        mode === 'login'
          ? await api.auth.login({ username, password, remember })
          : await api.auth.register({ username, email: email.trim() || null, password });
      setUser(user);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  const openDemo = async (): Promise<void> => {
    setError(null);
    setBusy('demo');
    try {
      setUser(await api.auth.loginDemo());
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-[420px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="mb-3 flex size-12 items-center justify-center rounded-xl bg-brand text-brand-ink">
            <ChartNoAxesCombined className="size-6" aria-hidden />
          </div>
          <h1 className="text-xl font-semibold text-ink">Portofoliu Bursa</h1>
          <p className="mt-1 text-body text-ink-2">Acțiuni, ETF-uri, obligațiuni și crypto, într-un singur loc.</p>
        </div>

        <div className="rounded-xl border border-line bg-surface p-6">
          <div className="mb-5 grid grid-cols-2 rounded-lg bg-surface-2 p-0.5">
            {(['login', 'register'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => switchMode(m)}
                className={`rounded-md py-1.5 text-body font-medium transition ${mode === m ? 'bg-surface text-ink shadow-sm' : 'text-ink-2 hover:text-ink'}`}
              >
                {m === 'login' ? 'Autentificare' : 'Cont nou'}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-3.5">
            <Field label="Nume utilizator">
              <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" required minLength={3} maxLength={32} />
            </Field>
            {mode === 'register' && (
              <Field label="Email (opțional)">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
              </Field>
            )}
            <Field label="Parolă" hint={mode === 'register' ? 'Cel puțin 8 caractere.' : undefined}>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                required
                minLength={mode === 'register' ? 8 : 1}
              />
            </Field>
            {mode === 'register' && (
              <Field label="Confirmă parola">
                <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
              </Field>
            )}
            {mode === 'login' && (
              <label className="flex items-center gap-2 text-body text-ink-2">
                <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} className="size-4 accent-(--accent)" />
                Ține-mă minte pe acest calculator
              </label>
            )}

            {error && <Notice tone="loss">{error}</Notice>}

            <Button type="submit" variant="primary" loading={busy === 'form'} disabled={busy !== null} className="w-full">
              {mode === 'login' ? 'Intră în cont' : 'Creează contul'}
            </Button>
          </form>

          <div className="my-4 flex items-center gap-3 text-xs text-ink-3">
            <span className="h-px flex-1 bg-line" />
            sau
            <span className="h-px flex-1 bg-line" />
          </div>

          <Button onClick={openDemo} loading={busy === 'demo'} disabled={busy !== null} icon={<FlaskConical className="size-4" />} className="w-full">
            Încearcă contul demo
          </Button>
          <p className="mt-2 text-center text-xs text-ink-3">Date de test la doi brokeri: acțiuni, un ETF, o obligațiune și crypto.</p>
        </div>

        <p className="mt-4 flex items-center justify-center gap-1.5 text-xs text-ink-3">
          <ShieldCheck className="size-3.5" aria-hidden />
          Datele rămân doar pe acest calculator. Parola se păstrează ca hash.
        </p>
      </div>
    </div>
  );
}
