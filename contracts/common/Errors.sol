// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

contract Errors {
    // Common
    error ZeroAddressProvided();
    error ZeroAmountProvided();
    error InvalidBasisPointHigherThan10000();
    error InsufficientAmountForRequest();
    error InsufficientSharesForRequest();
    error UnsupportedFunction();

    // Security
    error AdminRequired();
    error PoolOperatorRequired();
    error PoolOwnerRequired();
    error ProtocolOwnerRequired();
    error PoolOwnerOrEARequired();
    error PauserRequired();
    error NFTOwnerRequired();
    error LenderRequired();
    error BorrowerRequired();
    error BorrowerOrEARequired();
    error PayerRequired();
    error CoverProviderRequired();
    error AuthorizedContractRequired();
    error EvaluationAgentServiceAccountRequired();
    error SentinelServiceAccountRequired();
    error TrancheRequired();

    // Protocol config
    error TreasuryFeeHighThanUpperLimit();
    error AlreadyAPauser();
    error AlreadyPoolAdmin();

    // Pool config
    error ProposedEADoesNotOwnProvidedEANFT();
    error UnderlyingTokenNotApprovedForHumaProtocol();
    error AdminRewardRateTooHigh();
    error PoolOwnerInsufficientLiquidity();
    error EvaluationAgentInsufficientLiquidity();
    error MinDepositAmountTooLow();

    // Pool state
    error ProtocolIsPaused();
    error PoolIsNotOn();
    error PoolIsNotReadyForFirstLossCoverWithdrawal();

    // Calendar
    error StartDateLaterThanEndDate();

    // Tranche
    error TrancheLiquidityCapExceeded();
    error DepositAmountTooLow();
    error WithdrawTooEarly();
    error InvalidTrancheIndex();
    error EpochClosedTooEarly();
    error AlreadyALender();
    error NonReinvestYieldLenderCapacityReached();
    error ReinvestYieldOptionAlreadySet();

    // First loss cover
    error InsufficientFirstLossCover();
    error FirstLossCoverLiquidityCapExceeded();
    error TooManyProviders();
    error AlreadyAProvider();
    error ProviderHasOutstandingAssets();

    // Credit
    error ZeroPayPeriods();
    error CreditLimitTooHigh();
    error CommittedAmountGreaterThanCreditLimit();
    error CreditWithoutCommitmentShouldHaveNoDesignatedStartDate();
    error DesignatedStartDateInThePast();
    error CommittedCreditCannotBeStarted();
    error CreditNotInStateForDrawdown();
    error CreditLimitExceeded();
    error FirstDrawdownTooEarly();
    error AttemptedDrawdownOnNonRevolvingLine();
    error InsufficientPoolBalanceForDrawdown();
    error BorrowAmountLessThanPlatformFees();
    error CreditNotInStateForMakingPayment();
    error CreditNotInStateForMakingPrincipalPayment();
    error CreditNotInStateForUpdate();
    error CreditHasOutstandingBalance();
    error CreditHasUnfulfilledCommitment();
    error DefaultTriggeredTooEarly();
    error DefaultHasAlreadyBeenTriggered();
    error ReceivableAlreadyMatured();
    error InvalidReceivableState();
    error DrawdownNotAllowedInFinalPeriodAndBeyond();
    error DrawdownNotAllowedAfterDueDateWithUnpaidDue();
    error PayPeriodsTooLowForCreditsWithDesignatedStartDate();

    // Receivable
    error ReceivableIdMismatch();
    error InsufficientReceivableAmount();
    error ZeroReceivableAmount();
    error ZeroReceivableIdProvided();
    error ReceivableOwnerRequired();
    error ReceivableOwnerOrCreatorRequired();
    error ReceivableReferenceIdAlreadyExists();

    // Superfluid
    error DurationTooLong();
    error InvalidFlowRate();
    error OnlySuperfluid();
    error BorrowerMismatch();
    error FlowKeyMismatch();
    error FlowIsNotTerminated();
    error InvalidSuperfluidCallback();
    error InvalidSuperfluidAction();
    error NotTradableStreamOwner();
    error TradableStreamNotExisting();
    error TradableStreamNotMatured();
    error InsufficientAvailableFlowRate();
    error AuthorizationExpired();
    error InvalidAuthorization();
    error NewReceiverSameToOrigin();
}
