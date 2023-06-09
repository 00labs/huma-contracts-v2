// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {DealConfig} from "../DealStructs.sol";

interface IDealLogic {
    function calculateInterestAndPincipal(
        uint256 principal,
        uint256 startTime,
        uint256 lastUpdatedTime,
        DealConfig memory dealConfig
    ) external view returns (uint256 accruedInterest, uint256 accruedPrincipal);
}
