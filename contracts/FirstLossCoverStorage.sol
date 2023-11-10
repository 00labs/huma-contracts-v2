// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolSafe} from "./interfaces/IPoolSafe.sol";

contract FirstLossCoverStorage {
    struct LossCoverProviderConfig {
        // Percentage of the pool cap required to be covered by first loss cover
        uint16 poolCapCoverageInBps;
        // Percentage of the pool value required to be covered by first loss cover
        uint16 poolValueCoverageInBps;
    }

    IPool public pool;
    IPoolSafe public poolSafe;
    IERC20 public underlyingToken;

    uint8 internal _decimals;
    // The cumulative amount of loss covered.
    uint256 public coveredLoss;

    mapping(address => LossCoverProviderConfig) internal providerConfigs;

    uint256[100] private __gap;
}
