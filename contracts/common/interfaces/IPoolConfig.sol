// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;
import {FirstLossCoverConfig} from "../PoolConfig.sol";

/**
 * @notice IPoolConfig is an interface for factory to initialize pool config.
 */
interface IPoolConfig {
    function initialize(string memory _poolName, address[] memory _contracts) external;

    function setFirstLossCover(
        uint8 index,
        address firstLossCover,
        FirstLossCoverConfig memory config
    ) external;
}
