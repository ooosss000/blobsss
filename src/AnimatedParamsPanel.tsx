import { useState } from 'react';
import { ANIMATABLE_PARAM_KEYS } from './keyframes';
import type { AnimatableParamKey, ParamTracks, CurveType } from './keyframes';
import { ParamTrackRow } from './ParamTrackRow';

const PARAM_LABELS: Record<AnimatableParamKey, string> = {
  brightness: 'BRIGHTNESS',
  contrast: 'CONTRAST',
  saturation: 'SATURATION',
  hue: 'HUE',
  gamma: 'GAMMA',
  temperature: 'TEMPERATURE',
  strokeColor: 'STROKE',
  strokeWidth: 'STROKE W',
  renderMode: 'RENDER MODE',
};

interface AnimatedParamsPanelProps {
  paramTracks: ParamTracks;
  duration: number;
  disabled: boolean;
  selectedParamKeyframeIds: Partial<Record<AnimatableParamKey, string | null>>;
  onSelect: (key: AnimatableParamKey, id: string | null) => void;
  onRetime: (key: AnimatableParamKey, id: string, time: number) => void;
  onDelete: (key: AnimatableParamKey, id: string) => void;
  onAddAt: (key: AnimatableParamKey, time: number) => void;
  onSetCurve: (key: AnimatableParamKey, id: string, curve: CurveType) => void;
}

/**
 * Collapsible "ANIMATED PARAMS" section in the TransportDock — collapsed by
 * default, not a separate panel and not additional always-visible rows.
 * Shows exactly one ParamTrackRow per animatable param that currently has
 * ≥1 keyframe on its own track (a param with the stopwatch off, or with
 * zero keyframes after toggling off, simply has no row — see
 * toggleParamAnimation in App.tsx).
 */
export function AnimatedParamsPanel({
  paramTracks, duration, disabled, selectedParamKeyframeIds,
  onSelect, onRetime, onDelete, onAddAt, onSetCurve,
}: AnimatedParamsPanelProps) {
  const [expanded, setExpanded] = useState(false);

  const animatedKeys = ANIMATABLE_PARAM_KEYS.filter(key => (paramTracks[key]?.length ?? 0) > 0);

  if (animatedKeys.length === 0) return null;

  return (
    <div className="anim-params-panel">
      <div className="anim-params-header" onClick={() => setExpanded(e => !e)}>
        <span>{expanded ? '▾' : '▸'} ANIMATED PARAMS ({animatedKeys.length})</span>
      </div>
      {expanded && (
        <div className="anim-params-body">
          {animatedKeys.map(key => (
            <ParamTrackRow
              key={key}
              label={PARAM_LABELS[key]}
              paramKey={key}
              keyframes={paramTracks[key] ?? []}
              duration={duration}
              selectedId={selectedParamKeyframeIds[key] ?? null}
              onSelect={id => onSelect(key, id)}
              onRetime={(id, time) => onRetime(key, id, time)}
              onDelete={id => onDelete(key, id)}
              onAddAt={time => onAddAt(key, time)}
              onSetCurve={(id, curve) => onSetCurve(key, id, curve)}
              disabled={disabled}
            />
          ))}
        </div>
      )}
    </div>
  );
}
