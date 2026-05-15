import { ActiveSubscriptionLineItem } from './types';
/**
 * Converts string amounts to numbers in Money type objects
 */
export declare function convertMoneyAmount(data: any): any;
export declare function convertAppRecurringPricingMoney(data: any): void;
export declare function convertAppDiscountMoney(data: any): void;
export declare function convertAppUsagePricingMoney(data: any): void;
/**
 * Converts Money amounts in line items
 */
export declare function convertLineItems(lineItems: ActiveSubscriptionLineItem[]): ActiveSubscriptionLineItem[];
//# sourceMappingURL=utils.d.ts.map