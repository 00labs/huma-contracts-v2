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
    error insufficientSharesForRequest(); // 0x439f3ef3
    error insufficientTotalBalance(); // 0x300e0111
    error lessThanRequiredCover(); // 0xd0f0d90e
    error emptyArray(); // 0x81a5a837

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
    error drawdownFunctionUsedInsteadOfDrawdownWithReceivable(); // 0xf7a16c77
    error notNFTOwner(); // 0x091a5762
    error notProcessor(); // 0x90409ca1
    error notBorrower(); // 0xb18f4d11
    error notEpochManager(); // 0x34478df7
    error notPoolFeeManager(); // 0xe94f3252 // 0xd4017ec2
    error notTrancheVaultOrFirstLossCoverOrCreditOrPoolFeeManager(); // 0xdef0fded
    error notTrancheVaultOrEpochManager(); // 0x31c76c83
    error notTrancheVaultOrEpochManagerOrPoolFeeManagerOrFirstLossCover(); // 0x9c8c659b
    error notCurrentEpoch(); // 0x50c5dd13
    error notTrancheVault(); // 0x3d7640fb
    error notCoverProvider(); // 0xed74bd11

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
    error adminRewardRateTooHigh(); // 0x2d664ed8
    error poolOwnerNotEnoughLiquidity(); // 0xe95282e2
    error evaluationAgentNotEnoughLiquidity(); // 0x67e26217

    // pool state
    error protocolIsPaused(); // 0x8f6fa2d4
    error poolIsNotOn(); // 0x69b355df
    error poolIsNotReadyForFirstLossCoverWithdrawal(); // 0x20b8b473

    // tranche operation
    error poolLiquidityCapExceeded(); // 0xdea32e48
    error withdrawTooSoon(); // 0x67982472
    error maxSeniorJuniorRatioExceeded(); // 0x52fc3aa4
    error invalidTrancheIndex(); // 0xa82f3ece
    error closeTooSoon(); // 0xa38d0553

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
    error creditLineNotInStateForUpdate(); // 0x80cc0c6f
    error creditLineHasOutstandingBalance(); // 0x78272365
    error borrowingAmountLessThanPlatformFees(); // 0x97fde118
    error paymentAlreadyProcessed(); // 0xfd6754cf
    error settlementTooSoon(); // 0x0453e75e
    error defaultTriggeredTooEarly(); // 0x7872424e
    error defaultHasAlreadyBeenTriggered(); // 0xeb8d2ccc
    error committedAmountGreaterThanCreditLimit(); // 0x4ff6cc6f

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
    error notTradableStreamOwner(); // 0x5709a724
    error tradableStreamNotExisting(); // 0xb78e2a5b
    error tradableStreamNotMatured(); // 0xa42ebb88
    error notEnoughAvailableFlowrate(); // 0x9c808ab8
    error AuthorizationExpired(); // 0x0f05f5bf
    error InvalidAuthorization(); // 0x2ce87eeb
    error newReceiverSameToOrigin(); // 0x6d79ce50

    error invalidCalendarUnit(); // 0x353226f1
    error zeroPayPeriods(); // 0xd991f55d

    error todo(); // 0xb47f18a1
}
