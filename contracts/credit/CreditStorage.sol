// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity ^0.8.0;

import {HumaConfig} from "../common/HumaConfig.sol";
import {CreditRecord, DueDetail} from "./CreditStructs.sol";
import {ICreditDueManager} from "./interfaces/ICreditDueManager.sol";
import {ICreditManager} from "./interfaces/ICreditManager.sol";
import {IPoolSafe} from "../liquidity/interfaces/IPoolSafe.sol";
import {IFirstLossCover} from "../liquidity/interfaces/IFirstLossCover.sol";

contract CreditStorage {
    HumaConfig public humaConfig;

    // Reference to the due manager contract
    ICreditDueManager public dueManager;
    IPoolSafe public poolSafe;
    IFirstLossCover public firstLossCover;
    ICreditManager public creditManager;

    /// mapping from credit id to the credit record
    mapping(bytes32 => CreditRecord) internal _creditRecordMap;
    /// mapping from credit id to the credit record
    mapping(bytes32 => DueDetail) internal _dueDetailMap;

    /**
     * @dev This empty reserved space is put in place to allow future versions to add new
     * variables without shifting down storage in the inheritance chain.
     * See https://docs.openzeppelin.com/contracts/4.x/upgradeable#storage_gaps
     */
    uint256[100] private __gap;
}
