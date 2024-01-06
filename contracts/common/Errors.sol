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
    error PermissionDeniedNotAdmin();
    error PermissionDeniedNotLender();
    error EvaluationAgentServiceAccountRequired();
    error SentinelServiceAccountRequired();
    error PoolOperatorRequired();
    error NotPoolOwner();
    error NotProtocolOwner();
    error NotPoolOwnerOrEA();
    error NotPauser();
    error NotPool();
    error NotNFTOwner();
    error NotBorrower();
    error NotBorrowerOrEA();
    error NotCoverProvider();
    error NotAuthorizedCaller();
    error PermissionDeniedNotPayer();

    // Protocol config
    error DefaultGracePeriodLessThanMinAllowed();
    error TreasuryFeeHighThanUpperLimit();
    error AlreadyAPauser();
    error AlreadyPoolAdmin();

    // Pool config
    // TODO: Do we need this?
    error MinPrincipalPaymentRateSettingTooHigh();
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
    error WithdrawTooSoon();
    error InvalidTrancheIndex();
    error EpochClosureTooSoon();
    error AlreadyLender();
    error NotLender();
    error NonReinvestYieldLenderCapacityReached();
    error ReinvestYieldOptionAlreadySet();

    // First loss cover
    error LessThanRequiredCover();
    error FirstLossCoverLiquidityCapExceeded();
    error TooManyProviders();
    error AlreadyProvider();
    error ProviderHasOutstandingAssets();
    error NotProvider();

    // Credit
    error ZeroPayPeriods();
    error CreditLimitTooHigh();
    error CommittedAmountGreaterThanCreditLimit();
    error CreditWithoutCommitmentShouldHaveNoDesignatedStartDate();
    error DesignatedStartDateInThePast();
    error CommittedCreditCannotBeStarted();
    error CreditNotInStateForDrawdown();
    error CreditLineExceeded();
    error FirstDrawdownTooSoon();
    error AttemptedDrawdownOnNonRevolvingLine();
    error InsufficientPoolBalanceForDrawdown();
    error BorrowingAmountLessThanPlatformFees();
    error CreditLineNotInStateForMakingPayment();
    error CreditLineNotInStateForMakingPrincipalPayment();
    error CreditLineNotInStateForUpdate();
    error CreditLineHasOutstandingBalance();
    error CreditLineHasUnfulfilledCommitment();
    error DefaultTriggeredTooEarly();
    error DefaultHasAlreadyBeenTriggered();
    error ReceivableAlreadyMatured();
    error InvalidReceivableState();

    // Receivable
    error ReceivableIdMismatch();
    error InsufficientReceivableAmount();
    error ZeroReceivableAmount();
    error ZeroReceivableIdProvided();
    error NotReceivableOwner();
    error NotReceivableOwnerOrCreator();
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
