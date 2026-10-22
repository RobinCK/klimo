import { EntityId, KeyValueList } from '@ui';
import { brand } from '@brand';
import { t } from '@i18n';
import { haRoleText } from '../texts';
import type { SectionDef, SectionProps } from './types';

function Body(p: SectionProps) {
  return (
    <KeyValueList
      rows={p.room.haEntities.map((e) => ({
        key: haRoleText(e.role),
        value: <EntityId id={e.entityId} copyable />,
      }))}
    />
  );
}

export const haSection: SectionDef = {
  key: 'ha',
  icon: 'home',
  title: () => t('In Home Assistant'),
  subtitle: () => t('Entities via MQTT discovery. A target change from Home Assistant, HomeKit or voice follows the same rules as here.'),
  summary: (p) => {
    const climate = p.room.haEntities.find((e) => e.role === 'climate');
    const rest = p.room.haEntities.length - (climate ? 1 : 0);
    if (!p.room.haEntities.length) return t('not published yet — {product} needs MQTT', { product: brand.productName });
    return climate ? t('{entity} + {count} sensors', { entity: climate.entityId, count: rest }) : t('{count} sensors', { count: rest });
  },
  Body,
};
