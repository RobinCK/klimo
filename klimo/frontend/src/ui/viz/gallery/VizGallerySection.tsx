import { GalleryCharts } from './charts';
import { GalleryPlant } from './plant';
import { GalleryClimate } from './climate';
import { GalleryRows } from './rows';
import { galleryStyles as s } from './parts';

/** Charts, the plant diagram, meters and climate displays in their states, for `#/dev/ui` (rendered once per scheme). */
export function VizGallerySection(): JSX.Element {
  return (
    <div className={s.section}>
      <GalleryCharts />
      <GalleryPlant />
      <GalleryClimate />
      <GalleryRows />
    </div>
  );
}
