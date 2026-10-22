import { Body, Controller, Get, HttpStatus, Inject, Post } from '@nestjs/common';
import { ApiException } from '../common/http';
import { any, bool, entityId, int, num, obj, oneOf, opt, parse } from '../common/validate';
import type { ISimControl, SimFaultRequest, SimStateDto } from '../shared/model';
import { SIM_CONTROL } from '../tokens';
import { SCENARIO_IDS } from './scenarios';

const FAULT_KINDS = ['unavailable', 'stale', 'no_ack', 'weak', 'battery', 'knob', 'error_code', 'clear'] as const;

const ClockBody = obj({ speed: opt(num(0, 600)), jumpTo: opt(int(0, 4_102_444_800_000)), paused: opt(bool()) });
const ScenarioBody = obj({ id: oneOf(SCENARIO_IDS) });
const FaultBody = obj({ entityId: entityId(), kind: oneOf(FAULT_KINDS), value: opt(any()) });
const WindowBody = obj({ entityId: entityId(['binary_sensor']), open: bool() });
const OutdoorBody = obj({ tempC: num(-40, 50) });

function notFound(e: unknown): ApiException {
  return new ApiException(HttpStatus.NOT_FOUND, 'not_found', e instanceof Error ? e.message : String(e));
}

/** Simulator controls (registered only with KLIMO_SIMULATE=1): clock, scenarios, faults, weather. */
@Controller('api/sim')
export class SimController {
  constructor(@Inject(SIM_CONTROL) private readonly sim: ISimControl) {}

  @Get('state')
  state(): SimStateDto {
    return this.sim.state();
  }

  @Post('clock')
  clock(@Body() body: unknown): SimStateDto {
    return this.sim.clock(parse(body, ClockBody));
  }

  @Post('scenario')
  scenario(@Body() body: unknown): Promise<SimStateDto> {
    return this.sim.scenario(parse(body, ScenarioBody).id);
  }

  @Post('fault')
  fault(@Body() body: unknown): SimStateDto {
    const req = parse(body, FaultBody);
    if (req.value !== undefined && typeof req.value !== 'number' && typeof req.value !== 'string') {
      throw new ApiException(HttpStatus.BAD_REQUEST, 'validation', 'value must be a number or a string', [{ path: 'value', code: 'type', params: { expected: 'number|string' } }]);
    }
    try {
      return this.sim.fault(req as SimFaultRequest);
    } catch (e) {
      throw notFound(e);
    }
  }

  @Post('window')
  window(@Body() body: unknown): SimStateDto {
    const req = parse(body, WindowBody);
    try {
      return this.sim.window(req.entityId, req.open);
    } catch (e) {
      throw notFound(e);
    }
  }

  @Post('outdoor')
  outdoor(@Body() body: unknown): SimStateDto {
    return this.sim.outdoor(parse(body, OutdoorBody).tempC);
  }
}
