import { type ShopifyLogger } from '../lib/logger';
import { type ConfigInterface } from '../lib/base-types';
/**
 * Future flags are used to enable features that are not yet available by default.
 */
export interface FutureFlags {
    /**
     * Enable support for managed pricing, so apps can check for payments without needing a billing config.
     */
    unstable_managedPricingSupport?: boolean;
    /**
     * Change the CustomerAddress classes to expose a `is_default` property instead of `default` when fetching data. This
     * resolves a conflict with the default() method in that class.
     */
    customerAddressDefaultFix?: boolean;
}
/**
 * Configuration option for future flags.
 */
export type FutureFlagOptions = FutureFlags | undefined;
export type FeatureEnabled<Future extends FutureFlagOptions, Flag extends keyof FutureFlags> = Future extends FutureFlags ? Future[Flag] extends true ? true : false : false;
export declare function logDisabledFutureFlags(config: ConfigInterface, logger: ShopifyLogger): void;
//# sourceMappingURL=flags.d.ts.map