// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

contract Errors {
    // common
    error sameValue(); // 0x0811ff09
    error zeroAddressProvided(); // 0x5ff75ab0
    error zeroAmountProvided(); // 0x71799f2a
    error amountTooLow(); // 0x5b05bfbf
    error invalidBasisPointHigherThan10000(); // 0x07982d85
    error withdrawnAmountHigherThanBalance(); // 0x477c0ab2
    error allowanceTooLow(); // 0xcd8ef369
    error shareHigherThanRequested();
    error insufficientTotalBalance();
    error lessThanRequiredCover();

    // security
    error permissionDeniedNotAdmin(); // 0xf2c5b6a7
    error permissionDeniedNotLender(); // 0x68299b20
    error evaluationAgentServiceAccountRequired(); // 0x9b3b1ed6
    error paymentDetectionServiceAccountRequired(); // 0x731b978f
    error poolOperatorRequired(); // 0xdc2dc6d0
    error notPoolOwner(); // 0xd39208c9
    error notProtocolOwner(); // 0x97924c20
    error notEvaluationAgent(); // 0x66f7b8b7
    error notOperator(); // 0xf67113fe
    error notPoolOwnerTreasury(); // 0x325bf3c2
    error notPoolOwnerOrEA(); // 0xd6ed9384
    error notPoolOwnerTreasuryOrEA(); // 0xc74cb44c
    error notPauser(); // 0xdcdea7c8
    error notPool(); // 0x26d29bbf
    error drawdownFunctionUsedInsteadofDrawdownWithReceivable(); // 0x7e737537
    error notNFTOwner(); // 0x091a5762
    error notProcessor(); // 0x90409ca1
    error notBorrower();
    error notEpochManager();
    error notPlatformFeeManager();
    error notTrancheVaultOrLossCoverer();
    error notTrancheVaultOrEpochManager();
    error notCurrentEpoch();

    // system config
    error defaultGracePeriodLessThanMinAllowed(); // 0xa733ff9c
    error treasuryFeeHighThanUpperLimit(); // 0x39cda0d1
    error alreadyAnOperator(); // 0x75cea0fc
    error alreadyAPauser(); // 0x9f694c22
    error alreadyPoolAdmin(); // 0x7bb356e2

    // fee config
    error minPrincipalPaymentRateSettingTooHigh(); // 0xc11fc042

    // pool config
    error proposedEADoesNotOwnProvidedEANFT(); // 0x75b0da3b
    error underlyingTokenNotApprovedForHumaProtocol(); // 0xce179d6d
    error poolOwnerNotEnoughLiquidity(); // 0xe95282e2
    error evaluationAgentNotEnoughLiquidity(); // 0x67e26217

    // pool state
    error protocolIsPaused(); // 0x8f6fa2d4
    error poolIsNotOn(); // 0x69b355df

    // tranche operation
    error exceededPoolLiquidityCap(); // 0x5642ebd4
    error withdrawTooSoon(); // 0x67982472
    error exceededMaxSeniorJuniorRatio();
    error invalidTrancheIndex();
    error closeTooSoon();

    // credit operation
    error creditExpiredDueToFirstDrawdownTooLate(); // 0x9fac7390
    error creditExpiredDueToMaturity(); // 0xa52f3c3f
    error creditLineNotInGoodStandingState(); // 0x96e79474
    error creditLineNotInStateForMakingPayment(); // 0xf023e48b
    error creditLineNotInStateForDrawdown(); // 0x4ff95a6d
    error creditLineExceeded(); // 0xef7d66ff
    error creditLineAlreadyExists(); // 0x6c5805f2
    error creditLineGreatThanUpperLimit(); // 0xd8c27d2f
    error greaterThanMaxCreditLine(); // 0x8a754ae8
    error requestedCreditWithZeroDuration(); // 0xb16dd34d
    error onlyBorrowerOrEACanReduceCreditLine(); // 0xd61dbe31
    error creditLineNotInApprovedState(); // 0xfc91a989
    error paymentIdNotUnderReview(); // 0xd1696aaa
    error creditLineTooHigh(); // 0x552b8377
    error creditLineOutstanding(); // 0xc64e338c
    error creditLineNotInStateForUpdate();
    error creditLineHasOutstandingBalance();
    error borrowingAmountLessThanPlatformFees(); // 0x97fde118
    error paymentAlreadyProcessed(); // 0xfd6754cf
    error settlementTooSoon(); // 0x0453e75e
    error defaultTriggeredTooEarly(); // 0x7872424e
    error defaultHasAlreadyBeenTriggered(); // 0xeb8d2ccc

    // receivable operation
    error receivableAssetMismatch(); // 0x41dbeec1
    error receivableIdMismatch(); // 0x97be2b67
    error unsupportedReceivableAsset(); // 0xe60c383e
    error receivableAssetParamMismatch(); // 0x1400a0b4
    error insufficientReceivableAmount(); // 0xf7f34854

    // superfluid
    error durationTooLong(); // 0xf1dd53a8
    error invalidFlowrate(); // 0xd06a9328
    error onlySuperfluid(); // 0x3f9cd1c2
    error borrowerMismatch(); // 0x27d3e640
    error flowKeyMismatch(); // 0x29d5a5f3
    error flowIsNotTerminated(); // 0xe9c5922f
    error invalidSuperfluidCallback(); // 0xd2747f83
    error invalidSuperfluidAction(); // 0x2f2cd9e9

    error invalidCalendarUnit();
    error zeroPayPeriods();

    error todo();
}
