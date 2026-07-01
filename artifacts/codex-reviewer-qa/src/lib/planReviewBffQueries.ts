/**
 * React-query hooks for plan-review BFF reads.
 * Query keys match @workspace/api-client-react so invalidation stays compatible.
 */
import {
  useQuery,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import {
  getGetSubmissionFindingsGenerationStatusQueryKey,
  getListEngagementSubmissionsQueryKey,
  getListSubmissionFindingsQueryKey,
  type EngagementSubmissionSummary,
  type ListSubmissionFindingsResponse,
  type SubmissionFindingsGenerationStatusResponse,
} from "@workspace/api-client-react";
import {
  fetchEngagementSubmissions,
  fetchSubmissionFindings,
  fetchSubmissionFindingsStatus,
} from "./planReviewBff";

type QueryOpts<TData, TError> = {
  query?: Partial<UseQueryOptions<TData, TError, TData>>;
};

export function usePlanReviewEngagementSubmissions(
  engagementId: string,
  options?: QueryOpts<EngagementSubmissionSummary[], Error>,
): UseQueryResult<EngagementSubmissionSummary[], Error> {
  const { query: queryOptions } = options ?? {};
  const queryKey =
    queryOptions?.queryKey ??
    getListEngagementSubmissionsQueryKey(engagementId);

  return useQuery({
    queryKey,
    queryFn: () =>
      fetchEngagementSubmissions(engagementId) as Promise<
        EngagementSubmissionSummary[]
      >,
    enabled: Boolean(engagementId),
    ...queryOptions,
  });
}

export function usePlanReviewSubmissionFindings(
  submissionId: string,
  options?: QueryOpts<ListSubmissionFindingsResponse, Error>,
): UseQueryResult<ListSubmissionFindingsResponse, Error> {
  const { query: queryOptions } = options ?? {};
  const queryKey =
    queryOptions?.queryKey ??
    getListSubmissionFindingsQueryKey(submissionId);

  return useQuery({
    queryKey,
    queryFn: () =>
      fetchSubmissionFindings(submissionId) as Promise<ListSubmissionFindingsResponse>,
    enabled: Boolean(submissionId),
    ...queryOptions,
  });
}

export function usePlanReviewSubmissionFindingsStatus(
  submissionId: string,
  options?: QueryOpts<SubmissionFindingsGenerationStatusResponse, Error>,
): UseQueryResult<SubmissionFindingsGenerationStatusResponse, Error> {
  const { query: queryOptions } = options ?? {};
  const queryKey =
    queryOptions?.queryKey ??
    getGetSubmissionFindingsGenerationStatusQueryKey(submissionId);

  return useQuery({
    queryKey,
    queryFn: () =>
      fetchSubmissionFindingsStatus(submissionId) as Promise<SubmissionFindingsGenerationStatusResponse>,
    enabled: Boolean(submissionId),
    ...queryOptions,
  });
}
