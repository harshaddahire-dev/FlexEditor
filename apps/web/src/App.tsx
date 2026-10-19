import { useEffect } from 'react';
import * as Tooltip from '@radix-ui/react-tooltip';
import { useApp } from './store/app';
import { useUi } from './store/ui';
import { SetupScreen } from './components/SetupScreen';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Workspace } from './components/Workspace';

export function App() {
  const { booting, fatal, health, project, boot } = useApp();
  const theme = useUi((s) => s.theme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  useEffect(() => {
    void boot();
  }, [boot]);

  let body;
  if (booting) body = <div className="screen" aria-busy="true" />;
  else if (fatal)
    body = (
      <main className="screen">
        <div className="screen__col">
          <h1>Can’t reach the Cutroom server</h1>
          <div className="callout" role="alert">{fatal}</div>
          <div><button className="btn btn--primary" onClick={() => void boot()}>Retry</button></div>
        </div>
      </main>
    );
  else if (health && !health.ffmpeg.ok) body = <SetupScreen />;
  else if (!project) body = <WelcomeScreen />;
  else body = <Workspace />;

  return <Tooltip.Provider delayDuration={400}>{body}</Tooltip.Provider>;
}
