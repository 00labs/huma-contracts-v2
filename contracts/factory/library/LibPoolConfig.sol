// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig, PoolSettings, LPConfig, FrontLoadingFeesStructure, FeeStructure} from "../../common/PoolConfig.sol";
import {PayPeriodDuration} from "../../common/SharedDefs.sol";

library LibPoolConfig {
    function setPoolSettings(
        address _poolConfigAddress,
        uint96 maxCreditLine,
        uint96 minDepositAmount,
        PayPeriodDuration payPeriodDuration,
        uint8 latePaymentGracePeriodIndays,
        uint16 defaultGracePeriodInDays,
        uint16 advanceRateInBps,
        bool receivableAutoApproval
    ) public {
        PoolSettings memory settings = PoolSettings({
            maxCreditLine: maxCreditLine,
            minDepositAmount: minDepositAmount,
            payPeriodDuration: payPeriodDuration,
            latePaymentGracePeriodInDays: latePaymentGracePeriodIndays,
            defaultGracePeriodInDays: defaultGracePeriodInDays,
            advanceRateInBps: advanceRateInBps,
            receivableAutoApproval: receivableAutoApproval
        });
        PoolConfig(_poolConfigAddress).setPoolSettings(settings);
    }

    function setLPConfig(
        address _poolConfigAddress,
        uint96 liquidityCap,
        uint8 maxSeniorJuniorRatio,
        uint16 fixedSeniorYieldInBps,
        uint16 tranchesRiskAdjustmentInBps,
        uint16 withdrawalLockoutPeriodInDays
    ) public {
        LPConfig memory lpConfig = LPConfig({
            liquidityCap: liquidityCap,
            maxSeniorJuniorRatio: maxSeniorJuniorRatio,
            fixedSeniorYieldInBps: fixedSeniorYieldInBps,
            tranchesRiskAdjustmentInBps: tranchesRiskAdjustmentInBps,
            withdrawalLockoutPeriodInDays: withdrawalLockoutPeriodInDays
        });
        PoolConfig(_poolConfigAddress).setLPConfig(lpConfig);
    }

    function setFees(
        address _poolConfigAddress,
        uint96 frontLoadingFeeFlat,
        uint16 frontLoadingFeeBps,
        uint16 yieldInBps,
        uint16 minPrincipalRateInBps,
        uint16 lateFeeBps,
        uint256 poolOwnerRewardRate,
        uint256 poolOwnerLiquidityRate,
        uint256 eaRewardRate,
        uint256 eaLiquidityRate
    ) public {
        FrontLoadingFeesStructure memory frontLoadingFees = FrontLoadingFeesStructure({
            frontLoadingFeeFlat: frontLoadingFeeFlat,
            frontLoadingFeeBps: frontLoadingFeeBps
        });
        PoolConfig(_poolConfigAddress).setFrontLoadingFees(frontLoadingFees);
        FeeStructure memory fees = FeeStructure({
            yieldInBps: yieldInBps,
            minPrincipalRateInBps: minPrincipalRateInBps,
            lateFeeBps: lateFeeBps
        });
        PoolConfig(_poolConfigAddress).setFeeStructure(fees);
        PoolConfig(_poolConfigAddress).setPoolOwnerRewardsAndLiquidity(
            poolOwnerRewardRate,
            poolOwnerLiquidityRate
        );
        PoolConfig(_poolConfigAddress).setEARewardsAndLiquidity(eaRewardRate, eaLiquidityRate);
    }
}
