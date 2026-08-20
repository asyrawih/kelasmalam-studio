/**
 * Penanda versi di topbar — satu tempat yang menjawab "produksi lagi jalan di
 * build yang mana".
 *
 * Ia sengaja memakai `Badge` dengan `textTransform: none`: seluruh design ini
 * huruf besar, tapi commit hash yang di-uppercase tidak lagi bisa dicocokkan
 * begitu saja dengan keluaran `git log`, dan itu justru kegunaan utamanya.
 */

import { BUILD_INFO, versionLabel, versionTitle } from '../build-info';
import { Badge } from '../ui/cyber';

export interface VersionTagProps {
  /** Tinggi badge; topbar DJ dan landing lebih pendek dari topbar studio. */
  readonly height?: number;
}

export function VersionTag({ height = 22 }: VersionTagProps): JSX.Element {
  return (
    <Badge
      tone="default"
      height={height}
      title={versionTitle(BUILD_INFO)}
      style={{ textTransform: 'none', letterSpacing: '.08em', cursor: 'help' }}
    >
      {versionLabel(BUILD_INFO)}
    </Badge>
  );
}
