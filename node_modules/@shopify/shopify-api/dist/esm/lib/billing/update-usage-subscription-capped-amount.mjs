import { BillingError, GraphqlQueryError } from '../error.mjs';
import { graphqlClientClass } from '../clients/admin/graphql/client.mjs';
import '@shopify/admin-api-client';
import 'lossless-json';
import '../types.mjs';
import 'compare-versions';
import { APP_SUBSCRIPTION_FRAGMENT } from './types.mjs';
import { convertLineItems } from './utils.mjs';

const UPDATE_USAGE_CAPPED_AMOUNT_MUTATION = `
${APP_SUBSCRIPTION_FRAGMENT}
mutation appSubscriptionLineItemUpdate($cappedAmount: MoneyInput!, $id: ID!) {
  appSubscriptionLineItemUpdate(cappedAmount: $cappedAmount, id: $id) {
    userErrors {
      field
      message
    }
    confirmationUrl
    appSubscription {
      ...AppSubscriptionFragment
    }
  }
}
`;
function updateUsageCappedAmount(config) {
    return async function updateUsageCappedAmount(params) {
        if (!config.billing) {
            throw new BillingError({
                message: 'Attempted to update line item without billing configs',
                errorData: [],
            });
        }
        const { session, subscriptionLineItemId, cappedAmount: { amount, currencyCode }, } = params;
        const GraphqlClient = graphqlClientClass({ config });
        const client = new GraphqlClient({ session });
        try {
            const response = await client.request(UPDATE_USAGE_CAPPED_AMOUNT_MUTATION, {
                variables: {
                    id: subscriptionLineItemId,
                    cappedAmount: {
                        amount,
                        currencyCode,
                    },
                },
            });
            if (response.data?.appSubscriptionLineItemUpdate?.userErrors.length) {
                throw new BillingError({
                    message: 'Error while updating usage subscription capped amount',
                    errorData: response.data?.appSubscriptionLineItemUpdate?.userErrors,
                });
            }
            const appSubscription = response.data?.appSubscriptionLineItemUpdate?.appSubscription;
            if (appSubscription && appSubscription.lineItems) {
                appSubscription.lineItems = convertLineItems(appSubscription.lineItems);
            }
            return {
                confirmationUrl: response.data?.appSubscriptionLineItemUpdate?.confirmationUrl,
                appSubscription,
            };
        }
        catch (error) {
            if (error instanceof GraphqlQueryError) {
                throw new BillingError({
                    message: error.message,
                    errorData: error.response?.errors,
                });
            }
            throw error;
        }
    };
}

export { updateUsageCappedAmount };
//# sourceMappingURL=update-usage-subscription-capped-amount.mjs.map
