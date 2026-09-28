// Stub interfaces only (todo1). Real logic owned by separate workers:
// parser -> todo2, build -> todo3, flash -> todo4, live/elf -> todo5.
// MUST NOT implement parser/build/flash logic here.

export interface ProjectConfig {
  readonly mcu: string;
  readonly cprojectPath: string;
}

export interface BuildResult {
  readonly ok: boolean;
  readonly elfPath?: string;
  readonly message: string;
}

export interface FlashRequest {
  readonly elfPath: string;
  readonly verify: boolean;
}

export interface LiveSample {
  readonly timestamp: string;
  readonly address: string;
  readonly name: string;
  readonly value: string;
}

export interface IParser {
  parseCproject(xmlText: string): ProjectConfig;
}

export interface IBuildBackend {
  build(config: ProjectConfig): Promise<BuildResult>;
}

export interface IFlashBackend {
  flash(req: FlashRequest): Promise<BuildResult>;
  dryRunCommand(req: FlashRequest): string;
}

export interface ILiveBackend {
  readAll(): Promise<LiveSample[]>;
}

// Unimplemented stubs: throw on use so misuse is loud in tests.
export const notImplementedParser: IParser = {
  parseCproject(): ProjectConfig {
    throw new Error("parser not implemented (todo2 owns this)");
  },
};

export function buildFlashCommand(cliPath: string, elfPath: string): string {
  // Canonical shape asserted by todo4 dry-run test:
  // STM32_Programmer_CLI -c port=SWD -w <elf> -v -rst
  return `${cliPath} -c port=SWD -w ${elfPath} -v -rst`;
}
