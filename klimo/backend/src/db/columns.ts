import { Column, PrimaryColumn, ValueTransformer } from 'typeorm';

/**
 * Column conventions shared by every table: ids `varchar(64)`, HA entity ids `varchar(255)`, names
 * `varchar(80)`, enums `varchar(24)`, timestamps epoch-ms `bigint`, nested objects `simple-json`.
 * Numbers with a fraction are `double precision` — MySQL and Postgres `float` is single precision and
 * would turn 21.3 °C into 21.299999.
 */

/** pg and mysql return bigint as a string; the engine wants numbers. */
export const ms: ValueTransformer = {
  to: (v: unknown) => v,
  from: (v: unknown) => (v === null || v === undefined ? v : Number(v)),
};

export const PkCol = (length = 64) => PrimaryColumn({ type: 'varchar', length });
export const IdCol = (nullable = false) => Column({ type: 'varchar', length: 64, nullable });
export const EntityCol = (nullable = false) => Column({ type: 'varchar', length: 255, nullable });
export const NameCol = (nullable = false) => Column({ type: 'varchar', length: 80, nullable });
export const EnumCol = (nullable = false) => Column({ type: 'varchar', length: 24, nullable });
export const StrCol = (length: number, nullable = false) => Column({ type: 'varchar', length, nullable });
export const TextCol = () => Column({ type: 'text' });
export const TsCol = (nullable = false) => Column({ type: 'bigint', nullable, transformer: ms });
export const FloatCol = (nullable = false) => Column({ type: 'double precision', nullable });
export const IntCol = () => Column({ type: 'int' });
export const BoolCol = (nullable = false) => Column({ type: 'boolean', nullable });
/** Nested objects and arrays; nullable so later fields need no database default (read via withDefaults). */
export const JsonCol = () => Column({ type: 'simple-json', nullable: true });
