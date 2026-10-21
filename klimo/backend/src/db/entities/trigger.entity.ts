import { Entity } from 'typeorm';
import type { ConditionNode, RuleEffect, Trigger } from '../../shared/model';
import { BoolCol, EnumCol, IntCol, JsonCol, NameCol, PkCol } from '../columns';

@Entity('trigger')
export class TriggerRow {
  @PkCol() id: string;
  @NameCol() name: string;
  @EnumCol() icon: string;
  @EnumCol() kind: string;
  @JsonCol() condition: ConditionNode;
  @BoolCol() enabled: boolean;
  @JsonCol() system: Trigger['system'];
  @EnumCol() whenUnknown: string;
  @IntCol() holdMaxMin: number;
  @BoolCol() notifyOnActivate: boolean;
  @IntCol() order: number;
}

@Entity('trigger_rule')
export class TriggerRuleRow {
  @PkCol() id: string;
  @NameCol() name: string;
  @BoolCol() enabled: boolean;
  @IntCol() priority: number;
  @JsonCol() when: ConditionNode;
  @JsonCol() stopWhen: ConditionNode | null;
  @JsonCol() effects: RuleEffect[];
  @BoolCol() notifyOnActivate: boolean;
}
