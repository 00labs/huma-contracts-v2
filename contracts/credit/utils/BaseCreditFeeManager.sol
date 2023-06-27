// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {ICreditFeeManager} from "./interfaces/ICreditFeeManager.sol";
import {CreditConfig} from "../CreditStructs.sol";
import {PoolConfig} from "../../PoolConfig.sol";

contract BaseCreditFeeManager is ICreditFeeManager {
    PoolConfig public poolConfig;

    function accruedDebt(
        uint256 principal,
        uint256 startTime,
        uint256 lastUpdatedTime,
        CreditConfig memory dealConfig
    ) external view virtual returns (uint256 accruedInterest, uint256 accruedPrincipal) {}
}
