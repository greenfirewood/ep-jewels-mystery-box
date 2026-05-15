'use strict';

/**
 * Converts string amounts to numbers in Money type objects
 */
function convertMoneyAmount(data) {
    if (!data)
        return data;
    convertAppUsagePricingMoney(data);
    convertAppRecurringPricingMoney(data);
    convertAppDiscountMoney(data);
    return data;
}
function convertAppRecurringPricingMoney(data) {
    if (!data)
        return;
    if (data.price?.amount && typeof data.price.amount === 'string') {
        data.price.amount = parseFloat(data.price.amount);
    }
}
function convertAppDiscountMoney(data) {
    if (!data)
        return;
    if (data.discount?.priceAfterDiscount?.amount &&
        typeof data.discount.priceAfterDiscount.amount === 'string') {
        data.discount.priceAfterDiscount.amount = parseFloat(data.discount.priceAfterDiscount.amount);
    }
    if (data.discount?.value?.amount?.amount &&
        typeof data.discount.value.amount.amount === 'string') {
        data.discount.value.amount.amount = parseFloat(data.discount.value.amount.amount);
    }
}
function convertAppUsagePricingMoney(data) {
    if (!data)
        return;
    if (data.balanceUsed?.amount && typeof data.balanceUsed.amount === 'string') {
        data.balanceUsed.amount = parseFloat(data.balanceUsed.amount);
    }
    if (data.cappedAmount?.amount &&
        typeof data.cappedAmount.amount === 'string') {
        data.cappedAmount.amount = parseFloat(data.cappedAmount.amount);
    }
}
/**
 * Converts Money amounts in line items
 */
function convertLineItems(lineItems) {
    return lineItems.map((item) => {
        if (item.plan?.pricingDetails) {
            item.plan.pricingDetails = convertMoneyAmount(item.plan.pricingDetails);
        }
        return item;
    });
}

exports.convertAppDiscountMoney = convertAppDiscountMoney;
exports.convertAppRecurringPricingMoney = convertAppRecurringPricingMoney;
exports.convertAppUsagePricingMoney = convertAppUsagePricingMoney;
exports.convertLineItems = convertLineItems;
exports.convertMoneyAmount = convertMoneyAmount;
//# sourceMappingURL=utils.js.map
