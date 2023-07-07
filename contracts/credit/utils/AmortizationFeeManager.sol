// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {BaseCreditFeeManager} from "./BaseCreditFeeManager.sol";
import {CreditConfig} from "../CreditStructs.sol";

contract AmortizationFeeManager is BaseCreditFeeManager {
    function accruedDebt(
        uint256 principal,
        uint256 startTime,
        uint256 lastUpdatedTime,
        CreditConfig memory dealConfig
    ) external view virtual override returns (uint256 accruedInterest, uint256 accruedPrincipal) {}
}
