import { useState } from 'react';

import { isSoundEnabled, setSoundEnabled } from '../notificationSound.js';
import { isGemmaDemo } from '../runtime.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';
import { Checkbox } from './ui/Checkbox.js';
import { MenuItem } from './ui/MenuItem.js';
import { Modal } from './ui/Modal.js';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  isDebugMode: boolean;
  onToggleDebugMode: () => void;
  alwaysShowOverlay: boolean;
  onToggleAlwaysShowOverlay: () => void;
  externalAssetDirectories: string[];
  watchAllSessions: boolean;
  onToggleWatchAllSessions: () => void;
  hooksEnabled: boolean;
  onToggleHooksEnabled: () => void;
}

export function SettingsModal({
  isOpen,
  onClose,
  isDebugMode,
  onToggleDebugMode,
  alwaysShowOverlay,
  onToggleAlwaysShowOverlay,
  externalAssetDirectories,
  watchAllSessions,
  onToggleWatchAllSessions,
  hooksEnabled,
  onToggleHooksEnabled,
}: SettingsModalProps) {
  const [soundLocal, setSoundLocal] = useState(isSoundEnabled);

  // The live Gemma demo runs in the browser with no VS Code / hooks / JSONL backend,
  // so those settings do nothing there — hide them and keep only what works (sound).
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={isGemmaDemo ? '설정' : 'Settings'}>
      {isGemmaDemo && (
        <div className="px-10 py-8 text-xs text-text-muted leading-[1.6]">
          이 서버는 <b>시각화 데모</b>입니다. 실제 결과물은 저장되지 않습니다. 병렬 에이전트
          워크스페이스로 실제 코드를 만들려면 README를 참고하세요.
          <br />
          <a
            href="https://github.com/SJJ-universe/pixel-agents"
            target="_blank"
            rel="noreferrer"
            className="text-accent underline"
          >
            github.com/SJJ-universe/pixel-agents
          </a>
        </div>
      )}
      {!isGemmaDemo && (
        <>
          <MenuItem
            onClick={() => {
              transport.send({ type: 'openSessionsFolder' });
              onClose();
            }}
          >
            Open Sessions Folder
          </MenuItem>
          <MenuItem
            onClick={() => {
              transport.send({ type: 'exportLayout' });
              onClose();
            }}
          >
            Export Layout
          </MenuItem>
          <MenuItem
            onClick={() => {
              transport.send({ type: 'importLayout' });
              onClose();
            }}
          >
            Import Layout
          </MenuItem>
          <MenuItem
            onClick={() => {
              transport.send({ type: 'addExternalAssetDirectory' });
              onClose();
            }}
          >
            Add Asset Directory
          </MenuItem>
          {externalAssetDirectories.map((dir) => (
            <div key={dir} className="flex items-center justify-between py-4 px-10 gap-8">
              <span
                className="text-xs text-text-muted overflow-hidden text-ellipsis whitespace-nowrap"
                title={dir}
              >
                {dir.split(/[/\\]/).pop() ?? dir}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => transport.send({ type: 'removeExternalAssetDirectory', path: dir })}
                className="shrink-0"
              >
                x
              </Button>
            </div>
          ))}
        </>
      )}
      <Checkbox
        label={isGemmaDemo ? '소리 알림' : 'Sound Notifications'}
        checked={soundLocal}
        onChange={() => {
          const newVal = !isSoundEnabled();
          setSoundEnabled(newVal);
          setSoundLocal(newVal);
          transport.send({ type: 'setSoundEnabled', enabled: newVal });
        }}
      />
      {!isGemmaDemo && (
        <>
          <Checkbox
            label="Watch All Sessions"
            checked={watchAllSessions}
            onChange={onToggleWatchAllSessions}
          />
          <Checkbox
            label="Instant Detection (Hooks)"
            checked={hooksEnabled}
            onChange={onToggleHooksEnabled}
          />
          <Checkbox
            label="Always Show Labels"
            checked={alwaysShowOverlay}
            onChange={onToggleAlwaysShowOverlay}
          />
          <Checkbox label="Debug View" checked={isDebugMode} onChange={onToggleDebugMode} />
        </>
      )}
    </Modal>
  );
}
