// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {PoolConfig} from "../../common/PoolConfig.sol";

interface ITrancheVault {
    function initialize(
        string memory name,
        string memory symbol,
        PoolConfig _poolConfig,
        uint8 seniorTrancheOrJuniorTranche
    ) external;
}
