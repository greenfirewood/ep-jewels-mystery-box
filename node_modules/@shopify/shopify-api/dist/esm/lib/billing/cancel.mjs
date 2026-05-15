import { graphqlClientClass } from '../clients/admin/graphql/client.mjs';
import '@shopify/admin-api-client';
import 'lossless-json';
import { BillingError, GraphqlQueryError } from '../error.mjs';
import '../types.mjs';
import 'compare-versions';
import { APP_SUBSCRIPTION_FRAGMENT } from './types.mjs';

const CANCEL_MUTATION = `
  ${APP_SUBSCRIPTION_FRAGMENT}
  mutation appSubscriptionCancel($id: ID!, $prorate: Boolean) {
    appSubscriptionCancel(id: $id, prorate: $prorate) {
      appSubscription {
        ...AppSubscriptionFragment
      }
      userErrors {
        field
        message
      }
    }
  }
`;
function cancel(config) {
    return async function (subscriptionInfo) {
        const { session, subscriptionId, prorate = true } = subscriptionInfo;
        const GraphqlClient = graphqlClientClass({ config });
        const client = new GraphqlClient({ session });
        try {
            const response = await client.request(CANCEL_MUTATION, {
                variables: { id: subscriptionId, prorate },
            });
            if (response.data?.appSubscriptionCancel?.userErrors.length) {
                throw new BillingError({
                    message: 'Error while canceling a subscription',
                    errorData: response.data?.appSubscriptionCancel?.userErrors,
                });
            }
            return response.data?.appSubscriptionCancel?.appSubscription;
        }
        catch (error) {
            if (error instanceof GraphqlQueryError) {
                throw new BillingError({
                    message: error.message,
                    errorData: error.response?.errors,
                });
            }
            else {
                throw error;
            }
        }
    };
}

export { cancel };
//# sourceMappingURL=cancel.mjs.map
