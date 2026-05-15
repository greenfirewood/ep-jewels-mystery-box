'use strict';

var types$1 = require('../types.js');
var error = require('../error.js');
var getEmbeddedAppUrl = require('../auth/get-embedded-app-url.js');
var client = require('../clients/admin/graphql/client.js');
require('@shopify/admin-api-client');
require('lossless-json');
require('compare-versions');
var types = require('../../runtime/crypto/types.js');
var utils = require('../../runtime/crypto/utils.js');
var types$2 = require('./types.js');

const RECURRING_PURCHASE_MUTATION = `
  ${types$2.APP_SUBSCRIPTION_FRAGMENT}
  mutation AppSubscriptionCreate(
    $name: String!
    $returnUrl: URL!
    $test: Boolean
    $trialDays: Int
    $replacementBehavior: AppSubscriptionReplacementBehavior
    $lineItems: [AppSubscriptionLineItemInput!]!
  ) {
    appSubscriptionCreate(
      name: $name
      returnUrl: $returnUrl
      test: $test
      trialDays: $trialDays
      replacementBehavior: $replacementBehavior
      lineItems: $lineItems
    ) {
      appSubscription {
        ...AppSubscriptionFragment
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;
const ONE_TIME_PURCHASE_MUTATION = `
  mutation test(
    $name: String!
    $price: MoneyInput!
    $returnUrl: URL!
    $test: Boolean
  ) {
    appPurchaseOneTimeCreate(
      name: $name
      price: $price
      returnUrl: $returnUrl
      test: $test
    ) {
      appPurchaseOneTime {
        id
        name
        test
      }
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;
function request(config) {
    return async function ({ session, plan, isTest = true, returnUrl: returnUrlParam, returnObject = false, ...overrides }) {
        if (!config.billing || !config.billing[plan]) {
            throw new error.BillingError({
                message: `Could not find plan ${plan} in billing settings`,
                errorData: [],
            });
        }
        const billingConfig = {
            ...config.billing[plan],
        };
        const filteredOverrides = Object.fromEntries(Object.entries(overrides).filter(([_key, value]) => value !== undefined));
        const cleanShopName = session.shop.replace('.myshopify.com', '');
        const embeddedAppUrl = getEmbeddedAppUrl.buildEmbeddedAppUrl(config)(utils.hashString(`admin.shopify.com/store/${cleanShopName}`, types.HashFormat.Base64));
        const appUrl = `${config.hostScheme}://${config.hostName}?shop=${session.shop}`;
        // if provided a return URL, use it, otherwise use the embedded app URL or hosted app URL
        const returnUrl = returnUrlParam || (config.isEmbeddedApp ? embeddedAppUrl : appUrl);
        const GraphqlClient = client.graphqlClientClass({ config });
        const client$1 = new GraphqlClient({ session });
        function isLineItemPlan(billingConfig) {
            return 'lineItems' in billingConfig;
        }
        function isOneTimePlan(billingConfig) {
            return billingConfig.interval === types$1.BillingInterval.OneTime;
        }
        let data;
        if (isLineItemPlan(billingConfig)) {
            const mergedBillingConfigs = mergeBillingConfigs(billingConfig, filteredOverrides);
            const mutationRecurringResponse = await requestSubscriptionPayment({
                billingConfig: mergedBillingConfigs,
                plan,
                client: client$1,
                returnUrl,
                isTest,
            });
            data = mutationRecurringResponse.appSubscriptionCreate;
        }
        else if (isOneTimePlan(billingConfig)) {
            const mutationOneTimeResponse = await requestSinglePayment({
                billingConfig: { ...billingConfig, ...filteredOverrides },
                plan,
                client: client$1,
                returnUrl,
                isTest,
            });
            data = mutationOneTimeResponse.appPurchaseOneTimeCreate;
        }
        else {
            throw new error.BillingError({
                message: `Invalid billing configuration for plan ${plan}. Must be either a one-time plan or a subscription plan with line items.`,
                errorData: [],
            });
        }
        if (data.userErrors?.length) {
            throw new error.BillingError({
                message: 'Error while billing the store',
                errorData: data.userErrors,
            });
        }
        if (returnObject) {
            return data;
        }
        else {
            return data.confirmationUrl;
        }
    };
}
async function requestSubscriptionPayment({ billingConfig, plan, client, returnUrl, isTest, }) {
    const lineItems = billingConfig.lineItems.map((item) => {
        if (item.interval === types$1.BillingInterval.Every30Days ||
            item.interval === types$1.BillingInterval.Annual) {
            const appRecurringPricingDetails = {
                interval: item.interval,
                price: {
                    amount: item.amount,
                    currencyCode: item.currencyCode,
                },
            };
            if (item.discount) {
                appRecurringPricingDetails.discount = {
                    durationLimitInIntervals: item.discount.durationLimitInIntervals,
                    value: {
                        amount: item.discount.value.amount,
                        percentage: item.discount.value.percentage,
                    },
                };
            }
            return {
                plan: {
                    appRecurringPricingDetails,
                },
            };
        }
        else if (item.interval === types$1.BillingInterval.Usage) {
            const appUsagePricingDetails = {
                terms: item.terms,
                cappedAmount: {
                    amount: item.amount,
                    currencyCode: item.currencyCode,
                },
            };
            return {
                plan: {
                    appUsagePricingDetails,
                },
            };
        }
        else {
            throw new error.BillingError({
                message: 'Invalid interval provided',
                errorData: [item],
            });
        }
    });
    const mutationResponse = await client.request(RECURRING_PURCHASE_MUTATION, {
        variables: {
            name: plan,
            trialDays: billingConfig.trialDays,
            replacementBehavior: billingConfig.replacementBehavior,
            returnUrl,
            test: isTest,
            lineItems,
        },
    });
    if (mutationResponse.errors) {
        throw new error.BillingError({
            message: 'Error while billing the store',
            errorData: mutationResponse.errors,
        });
    }
    return mutationResponse.data;
}
async function requestSinglePayment({ billingConfig, plan, client, returnUrl, isTest, }) {
    const mutationResponse = await client.request(ONE_TIME_PURCHASE_MUTATION, {
        variables: {
            name: plan,
            returnUrl,
            test: isTest,
            price: {
                amount: billingConfig.amount,
                currencyCode: billingConfig.currencyCode,
            },
        },
    });
    if (mutationResponse.errors) {
        throw new error.BillingError({
            message: 'Error while billing the store',
            errorData: mutationResponse.errors,
        });
    }
    return mutationResponse.data;
}
function mergeBillingConfigs(billingConfig, overrides) {
    const mergedConfig = { ...billingConfig, ...overrides };
    const mergedLineItems = [];
    if (billingConfig.lineItems && overrides.lineItems) {
        for (const i of billingConfig.lineItems) {
            let found = false;
            for (const j of overrides.lineItems) {
                if (i.interval === j.interval) {
                    mergedLineItems.push({ ...i, ...j });
                    found = true;
                    break;
                }
            }
            if (!found) {
                mergedLineItems.push(i);
            }
        }
        mergedConfig.lineItems = mergedLineItems;
    }
    return mergedConfig;
}

exports.request = request;
//# sourceMappingURL=request.js.map
