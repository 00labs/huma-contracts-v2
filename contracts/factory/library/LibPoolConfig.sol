// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig, PoolSettings} from "../../common/PoolConfig.sol";
import {AFFILIATE_FIRST_LOSS_COVER_INDEX, HUNDRED_PERCENT_IN_BPS, PayPeriodDuration} from "../../common/SharedDefs.sol";

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
    ) public {}
}
