import type { BrandingDto } from '../shared/model';

/**
 * Backend brand constant: the product name in notifications, the MQTT device name and the cards'
 * `brand`. A rebrand changes this object (and `frontend/src/brand`); technical ids — the `klimo` slug,
 * `klimo_*` entity ids, `klimo/*` topics, `klimo-*` elements, the `klimo_event` bus event — never change.
 */
export const BRAND: Readonly<BrandingDto> = Object.freeze({
  productName: 'Klimo',
  idPrefix: 'klimo',
  colors: Object.freeze({ cold: '#4DA6FF', warm: '#FF8A3D', dot: '#F4F5F6' }),
  docsUrl: 'https://github.com/RobinCK/klimo',
});
