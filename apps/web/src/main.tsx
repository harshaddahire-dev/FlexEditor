import { timelineStats } from './timeline/render';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import './styles/tokens.css';
import './styles/base.css';
import './styles/app.css';
import './styles/polish.css';
import { App } from './App';
import { useApp } from './store/app';
import { useTimeline } from './store/timeline';
import { engine } from './playback/engine';
import { audioHook } from './audio/testHook';

// Test hook, dev server only (stripped from production builds).
if (import.meta.env.DEV) (window as unknown as { __cutroom: unknown }).__cutroom = { useApp, useTimeline, viewer: engine, audio: audioHook, timelineStats };

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
