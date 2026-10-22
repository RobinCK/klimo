import { GalleryContainers } from './containers';
import { GalleryInputs } from './inputs';
import { GalleryFeedback } from './feedback';
import { GalleryDisplay } from './display';
import { GalleryRows } from './rows';
import { galleryStyles as s } from './parts';

/** Every kit component in its states, for the developer page `#/dev/ui` (rendered once per scheme). */
export function KitGallerySection(): JSX.Element {
  return (
    <div className={s.section}>
      <GalleryContainers />
      <GalleryInputs />
      <GalleryFeedback />
      <GalleryDisplay />
      <GalleryRows />
    </div>
  );
}
