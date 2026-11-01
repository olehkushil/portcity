import 'reflect-metadata';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { DomainError } from '../errors/domain-error';
import { toProblemDetails } from '../errors/to-problem-details';
import { createValidationPipe } from './validation.pipe';

class DeviceDto {
  @IsString()
  platform: string;

  @IsOptional()
  @IsString()
  model?: string;
}

class VerifyDto {
  @IsString()
  phone: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  attempts: number;

  @ValidateNested()
  @Type(() => DeviceDto)
  device: DeviceDto;
}

describe('createValidationPipe', () => {
  const pipe = createValidationPipe();
  const metadata = { type: 'body' as const, metatype: VerifyDto, data: '' };

  it('transforms valid payloads into DTO instances', async () => {
    const result = (await pipe.transform(
      { phone: '+380501234567', attempts: '3', device: { platform: 'ios' } },
      metadata,
    )) as VerifyDto;
    expect(result).toBeInstanceOf(VerifyDto);
    expect(result.attempts).toBe(3);
    expect(result.device).toBeInstanceOf(DeviceDto);
  });

  it('reports nested field paths as PC_COMMON_VALIDATION with errors', async () => {
    let caught: unknown;
    try {
      await pipe.transform({ phone: 42, attempts: 0, device: { platform: 7 } }, metadata);
    } catch (error) {
      caught = error;
    }
    expect(DomainError.is(caught)).toBe(true);
    const problem = toProblemDetails(caught, { exposeInternalErrors: true });
    expect(problem.status).toBe(400);
    expect(problem.code).toBe('PC_COMMON_VALIDATION');
    const paths = (problem.errors ?? []).map((issue) => issue.path).sort();
    expect(paths).toEqual(['attempts', 'device.platform', 'phone']);
  });

  it('rejects unknown properties (forbidNonWhitelisted)', async () => {
    await expect(
      pipe.transform(
        { phone: '+380501234567', attempts: 1, device: { platform: 'ios' }, admin: true },
        metadata,
      ),
    ).rejects.toMatchObject({ code: 'PC_COMMON_VALIDATION' });
  });
});
