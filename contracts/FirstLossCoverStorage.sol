// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPoolVault} from "./interfaces/IPoolVault.sol";

contract FirstLossCoverStorage {
    struct LossCoverConfig {
        // Percentage of the pool cap required to be covered by first loss cover
        uint16 poolCapCoverageInBps;
        // Percentage of the pool value required to be covered by first loss cover
        uint16 poolValueCoverageInBps;
    }

    struct LossCoverPayoutConfig {
        // The percentage of a default to be paid by the first loss cover
        uint16 coverRateInBps;
        // The max amount that first loss cover can spend on one default
        uint96 coverCap;
        // The max liquidity allowed for the first loss cover
        uint96 liquidityCap;
    }

    IPool public pool;
    IPoolVault public poolVault;
    IERC20 public underlyingToken;

    uint8 internal _decimals;
    uint256 internal _totalAssets;
    /// The cumulative amount of loss covered.
    uint256 public coveredLoss;

    mapping(address => LossCoverConfig) internal operatorConfigs;
    LossCoverConfig internal maxCoverConfig;
    LossCoverPayoutConfig internal lossCoverPayoutConfig;

    uint256[100] private __gap;
}
