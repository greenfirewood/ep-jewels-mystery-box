import { AbstractFetchFunc, AdapterArgs, AdapterHeaders, NormalizedRequest, NormalizedResponse } from '../../runtime/http';
import type { Headers as HeaderRecord } from '../../runtime/http';
interface MockAdapterArgs extends AdapterArgs {
    rawRequest: NormalizedRequest;
}
export declare function mockConvertRequest(adapterArgs: MockAdapterArgs): Promise<NormalizedRequest>;
export declare function mockConvertResponse(response: NormalizedResponse, _adapterArgs: MockAdapterArgs): Promise<NormalizedResponse>;
export declare function mockConvertHeaders(headers: HeaderRecord, _adapterArgs: MockAdapterArgs): Promise<AdapterHeaders>;
export declare const mockFetch: AbstractFetchFunc;
export declare function mockRuntimeString(): string;
export {};
//# sourceMappingURL=adapter.d.ts.map