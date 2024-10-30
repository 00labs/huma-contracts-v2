// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.23;

contract Errors {
    // Common
    error ZeroAddressProvided(); // 0x84744201
    error ZeroAmountProvided(); // 0x8b127107
    error InvalidBasisPointHigherThan10000(); // 0x5995a7a4
    error InsufficientAmountForRequest(); // 0x66367127
    error InsufficientSharesForRequest(); // 0xb0ef6d99
    error ZeroSharesMinted(); // 0xd6a0a041
    error UnsupportedFunction(); // 0xea1c702e

    // Security
    error HumaOwnerRequired(); // 0x290df4f6
    error PoolOwnerOrHumaOwnerRequired(); // 0x3e984120
    error PoolOperatorRequired(); // 0xae7fe070
    error PoolOwnerRequired(); // 0x8b506451
    error HumaTreasuryRequired(); // 0x6e0a9ac9
    error PoolOwnerOrEARequired(); // 0xe54466f3
    error PauserRequired(); // 0xd4a99e4e
    error LenderRequired(); // 0x306fd1ae
    error BorrowerRequired(); // 0xeca877b1
    error BorrowerOrEARequired(); // 0xedaf53fe
    error PayerRequired(); // 0xb00f9713
    error CoverProviderRequired(); // 0x0c328563
    error AuthorizedContractCallerRequired(); // 0xf4bc99c7
    error EvaluationAgentRequired(); // 0x54a8b616
    error SentinelServiceAccountRequired(); // 0x272a85a5
    error TrancheRequired(); // 0x56b15134

    // Protocol config
    error TreasuryFeeHighThanUpperLimit(); // 0x743a9631
    error AlreadyAPauser(); // 0x2fe391f2

    // Pool config
    error UnderlyingTokenNotApprovedForHumaProtocol(); // 0x28918c5b
    error AdminRewardRateTooHigh(); // 0xa01087e8
    error PoolOwnerInsufficientLiquidity(); // 0xbd8efe51
    error EvaluationAgentInsufficientLiquidity(); // 0xc4c087d5
    error MinDepositAmountTooLow(); // 0xf250b9dc
    error LatePaymentGracePeriodTooLong(); // 0x2e727550

    // Pool state
    error ProtocolIsPaused(); // 0xaf0b004c
    error PoolIsNotOn(); // 0xf082b5c3
    error PoolIsNotReadyForFirstLossCoverWithdrawal(); // 0x3c2546a3
    error PoolIsNotClosed(); // 0x2faa680b

    // Calendar
    error StartDateLaterThanEndDate(); // 0xc496cd06

    // Tranche
    error TrancheLiquidityCapExceeded(); // 0x081917ff
    error DepositAmountTooLow(); // 0x55fcd027
    error WithdrawTooEarly(); // 0x64381803
    error InvalidTrancheIndex(); // 0x4e2a8dfe
    error EpochClosedTooEarly(); // 0xf6a9c460
    error RedemptionsCannotBeProcessedDueToUnprocessedProfit(); // 0x0f4579c3
    error AlreadyALender(); // 0xce4108ca
    error NonReinvestYieldLenderCapacityReached(); // 0x39ad903d
    error ReinvestYieldOptionAlreadySet(); // 0xb44d305d
    error RedemptionCancellationDisabled(); // 0x70c5f64d

    // First loss cover
    error InsufficientFirstLossCover(); // 0x86fdb63a
    error FirstLossCoverLiquidityCapExceeded(); // 0x2025075b
    error TooManyProviders(); // 0x71bcfb10
    error AlreadyAProvider(); // 0xd9234b22
    error ProviderHasOutstandingAssets(); // 0xff6a242c

    // Credit
    error ZeroPayPeriods(); // 0x02aef0da
    error CreditLimitTooHigh(); // 0x8aeadfa3
    error CommittedAmountGreaterThanCreditLimit(); // 0x40ea97e3
    error CreditWithoutCommitmentShouldHaveNoDesignatedStartDate(); // 0xdc0b99eb
    error DesignatedStartDateInThePast(); // 0xd2399737
    error CommittedCreditCannotBeStarted(); // 0x77ac341b
    error CreditNotInStateForDrawdown(); // 0x2b02d679
    error CreditLimitExceeded(); // 0xf2a56cf4
    error FirstDrawdownTooEarly(); // 0x3cc36a48
    error AttemptedDrawdownOnNonRevolvingLine(); // 0x6f878c73
    error InsufficientPoolBalanceForDrawdown(); // 0xd3026e45
    error BorrowAmountLessThanPlatformFees(); // 0xa21ec6a5
    error CreditNotInStateForMakingPayment(); // 0x65a28282
    error CreditNotInStateForMakingPrincipalPayment(); // 0xada2c6d3
    error CreditNotInStateForUpdate(); // 0xafa449c6
    error CreditHasOutstandingBalance(); // 0x73388b1a
    error CreditHasUnfulfilledCommitment(); // 0xb8fdadcc
    error DefaultTriggeredTooEarly(); // 0xe2e5216d
    error DefaultHasAlreadyBeenTriggered(); // 0x5c8d0ab5
    error ReceivableAlreadyMatured(); // 0xbcda5742
    error InvalidReceivableState(); // 0x185abea4
    error DrawdownNotAllowedInFinalPeriodAndBeyond(); // 0xda8ff4aa
    error DrawdownNotAllowedAfterDueDateWithUnpaidDue(); // 0x9e843389
    error PayPeriodsTooLowForCreditsWithDesignatedStartDate(); // 0x3078367e

    // Receivable
    error ReceivableIdMismatch(); // 0xbd56e3f5
    error InsufficientReceivableAmount(); // 0x1ef585b6
    error ZeroReceivableAmount(); // 0xe7883af2
    error ZeroReceivableIdProvided(); // 0x936f9c2c
    error ReceivableOwnerRequired(); // 0x966dff7d
    error ReceivableOwnerOrCreatorRequired(); // 0x6eae8328
    error ReceivableReferenceIdAlreadyExists(); // 0x6ff1906a

    // Factory
    error InvalidPoolId(); // 0x0afa7ee8
    error InvalidTranchesPolicyType(); // 0xdfeca9c2
    error InvalidCreditType(); // 0x0dcf2e93
    error DeployerRequired(); // 0x2e2bcb63
}
