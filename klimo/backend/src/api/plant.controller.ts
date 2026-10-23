import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { AdminOnly } from '../common/admin.guard';
import { CurrentActor } from '../common/user.middleware';
import { parse } from '../common/validate';
import { circuitModeDefaults } from '../shared/defaults';
import type { Actor, Circuit, CircuitDto, IConfigStore, Id, IReadModels, IRoomEdit, Manifold, Pump } from '../shared/model';
import { CONFIG_STORE, READ_MODELS, ROOM_EDIT } from '../tokens';
import {
  circuitCreateRequest,
  circuitMergeRequest,
  circuitPatch,
  circuitRoomRequest,
  forceQuery,
  manifoldCreateRequest,
  manifoldPatch,
  pumpCreateRequest,
  pumpPatch,
} from './schemas';
import { ApiRefs, found } from './support';

/**
 * Hydronics: heating/cooling circuits, their pumps and manifolds. Circuits are the house's: rooms join
 * them. A floor circuit runs as a whole with its source and a long run-on by default (screed stores
 * heat); a radiator circuit's pump follows the rooms.
 */
@Controller('api')
export class PlantController {
  constructor(
    @Inject(CONFIG_STORE) private readonly config: IConfigStore,
    @Inject(READ_MODELS) private readonly readModels: IReadModels,
    @Inject(ApiRefs) private readonly refs: ApiRefs,
    @Inject(ROOM_EDIT) private readonly edit: IRoomEdit,
  ) {}

  /* ── circuits ──────────────────────────────────────────────────────────────────────────────── */

  @Get('circuits')
  circuits(): CircuitDto[] {
    return this.readModels.circuits();
  }

  @Post('circuits')
  @AdminOnly()
  async createCircuit(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<CircuitDto> {
    const req = parse(body, circuitCreateRequest);
    const name = req.name ?? '';
    const floor = req.kind === 'floor';
    const value = {
      ...req,
      // floor loops can carry chilled water; radiators never do
      capabilities: { heat: req.capabilities?.heat ?? true, cool: req.capabilities?.cool ?? floor },
      shortName: req.shortName ?? name.slice(0, 24),
      mode: req.mode ?? circuitModeDefaults(req.kind ?? 'radiators').mode,
    };
    const created = await this.config.create('circuits', value as Omit<Circuit, 'id'>, actor);
    return this.circuit(created.id);
  }

  @Patch('circuits/:id')
  @AdminOnly()
  async patchCircuit(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<CircuitDto> {
    await this.config.update('circuits', id, parse(body, circuitPatch) as Partial<Circuit>, actor);
    return this.circuit(id);
  }

  /** 409 `in_use` while emitters or pumps hang on it, unless `force=1` (emitters parked, pumps removed). */
  @Delete('circuits/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async removeCircuit(@Param('id') id: Id, @Query() query: unknown, @CurrentActor() actor: Actor): Promise<void> {
    await this.config.remove('circuits', id, actor, { force: parse(query, forceQuery).force ?? false });
  }

  /** «Об’єднати»: rooms and pumps move to `intoId` (pumps can be dropped as the same pump), the empty circuit goes. */
  @Post('circuits/:id/merge')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  mergeCircuit(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<CircuitDto> {
    return this.edit.mergeCircuit(id, parse(body, circuitMergeRequest), actor);
  }

  /** A room joins the circuit (radiators without heads join as ordinary radiators; a zone only when zoned). */
  @Post('circuits/:id/rooms')
  @HttpCode(HttpStatus.OK)
  @AdminOnly()
  joinCircuit(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<CircuitDto> {
    return this.edit.joinCircuit(id, parse(body, circuitRoomRequest), actor);
  }

  /** The room leaves: its pump no longer runs for it, its heads are handed back, its zone is released. */
  @Delete('circuits/:id/rooms/:roomId')
  @AdminOnly()
  leaveCircuit(@Param('id') id: Id, @Param('roomId') roomId: Id, @CurrentActor() actor: Actor): Promise<CircuitDto> {
    return this.edit.leaveCircuit(id, roomId, actor);
  }

  /* ── pumps ─────────────────────────────────────────────────────────────────────────────────── */

  @Get('pumps')
  pumps(): Pump[] {
    return this.config.list('pumps');
  }

  @Get('pumps/:id')
  pump(@Param('id') id: Id): Pump {
    return found(this.config.get('pumps', id), 'Pump');
  }

  @Post('pumps')
  @AdminOnly()
  createPump(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<Pump> {
    const req = parse(body, pumpCreateRequest);
    const circuit = req.circuitId ? this.config.get('circuits', req.circuitId) : undefined;
    // the rule follows the circuit's mode (the store keeps them in step)
    const value: Partial<Pump> = { runOnHeatMin: circuitModeDefaults(circuit?.kind ?? 'radiators').runOnHeatMin, ...req };
    return this.config.create('pumps', value as Omit<Pump, 'id'>, actor);
  }

  /** A shorter run-on applies to a run-on already in progress. */
  @Patch('pumps/:id')
  @AdminOnly()
  patchPump(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<Pump> {
    return this.config.update('pumps', id, parse(body, pumpPatch) as Partial<Pump>, actor);
  }

  @Delete('pumps/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async removePump(@Param('id') id: Id, @CurrentActor() actor: Actor): Promise<void> {
    await this.config.remove('pumps', id, actor);
  }

  /** «Прокрутити»: runs the pump for 60 s now (anti-seize check). */
  @Post('pumps/:id/exercise')
  @HttpCode(HttpStatus.ACCEPTED)
  async exercise(@Param('id') id: Id, @CurrentActor() actor: Actor): Promise<void> {
    found(this.config.get('pumps', id), 'Pump');
    await this.refs.requireEngine().exercisePump(id, actor);
  }

  /* ── manifolds ─────────────────────────────────────────────────────────────────────────────── */

  @Get('manifolds')
  manifolds(): Manifold[] {
    return this.config.list('manifolds');
  }

  @Get('manifolds/:id')
  manifold(@Param('id') id: Id): Manifold {
    return found(this.config.get('manifolds', id), 'Manifold');
  }

  @Post('manifolds')
  @AdminOnly()
  createManifold(@Body() body: unknown, @CurrentActor() actor: Actor): Promise<Manifold> {
    return this.config.create('manifolds', parse(body, manifoldCreateRequest) as Omit<Manifold, 'id'>, actor);
  }

  @Patch('manifolds/:id')
  @AdminOnly()
  patchManifold(@Param('id') id: Id, @Body() body: unknown, @CurrentActor() actor: Actor): Promise<Manifold> {
    return this.config.update('manifolds', id, parse(body, manifoldPatch), actor);
  }

  /** Its circuits stay (without a manifold); its primary pumps go. */
  @Delete('manifolds/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @AdminOnly()
  async removeManifold(@Param('id') id: Id, @CurrentActor() actor: Actor): Promise<void> {
    await this.config.remove('manifolds', id, actor);
  }

  private circuit(id: Id): CircuitDto {
    return found(
      this.readModels.circuits().find((c) => c.config.id === id),
      'Circuit',
    );
  }
}
