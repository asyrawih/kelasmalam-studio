import { studioActions, useStudio } from '../store';
import { ToolbarButton } from './ToolbarButton';

export function SnapToggle(): JSX.Element {
  const enabled = useStudio((state) => state.snapEnabled);
  return (
    <ToolbarButton
      icon="⌁"
      label="SNAP"
      title="Magnetic snap antar-edge clip; mencegah overlap"
      active={enabled}
      onClick={() => studioActions.toggleSnap()}
    />
  );
}
